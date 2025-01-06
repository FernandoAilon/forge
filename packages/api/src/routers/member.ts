import type { TRPCRouterRecord } from "@trpc/server";
import { TRPCError } from "@trpc/server";
import QRCode from "qrcode";
import { z } from "zod";

import {
  BUCKET_NAME,
  DUES_PAYMENT,
  KNIGHTHACKS_S3_BUCKET_REGION,
} from "@forge/consts/knight-hacks";
import {
  and,
  count,
  eq,
  exists,
  getTableColumns,
  isNull,
  sql,
} from "@forge/db";
import { db } from "@forge/db/client";
import {
  DuesPayment,
  Event,
  EventAttendee,
  InsertMemberSchema,
  Member,
} from "@forge/db/schemas/knight-hacks";

import { minioClient } from "../minio/minio-client";
import { adminProcedure, protectedProcedure } from "../trpc";

export const memberRouter = {
  createMember: protectedProcedure
    .input(InsertMemberSchema.omit(
      { userId: true, age: true }))
    .mutation(async ({ input, ctx }) => {
      try {
        const userId = ctx.session.user.id;

        const existingMember = await db
          .select()
          .from(Member)
          .where(eq(Member.userId, userId));

        if (existingMember.length === 0) {
          const objectName = `qr-code-${userId}.png`;
          const bucketExists = await minioClient.bucketExists(BUCKET_NAME);

          if (!bucketExists) {
            await minioClient.makeBucket(
              BUCKET_NAME,
              KNIGHTHACKS_S3_BUCKET_REGION,
            );
          }

          const qrData = `user:${userId}`;
          const qrBuffer = await QRCode.toBuffer(qrData, { type: "png" });

          await minioClient.putObject(
            BUCKET_NAME,
            objectName,
            qrBuffer,
            qrBuffer.length,
            {
              "Content-Type": "image/png",
            },
          );
        }
      } catch (error) {
        console.error("Error with generating QR code: ", error);
      }

      const today = new Date();
      const birthDate = new Date(input.dob);
      const hasBirthdayPassed =
        birthDate.getMonth() <= today.getMonth() &&
        birthDate.getDate() <= today.getDate();
      const newAge = hasBirthdayPassed
        ? today.getFullYear() - birthDate.getFullYear()
        : today.getFullYear() - birthDate.getFullYear() - 1;

      await db.insert(Member).values({
        ...input,
        userId: ctx.session.user.id,
        age: newAge,
      });
    }),

  updateMember: adminProcedure
    .input(InsertMemberSchema.omit({ userId: true, age: true }))
    .mutation(async ({ input }) => {
      if (!input.id) {
        throw new TRPCError({
          message: "Member ID is required to update a member!",
          code: "BAD_REQUEST",
        });
      }

      const { id, dob, ...updateData } = input;

      const member = await db.query.Member.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });

      if (!member) {
        throw new TRPCError({
          message: "Member not found!",
          code: "NOT_FOUND",
        });
      }

      const resume = input.resumeUrl ? input.resumeUrl : member.resumeUrl;

      // Check if the age has been updated
      const today = new Date();
      const birthDate = new Date(dob);
      const hasBirthdayPassed =
        birthDate.getMonth() <= today.getMonth() &&
        birthDate.getDate() <= today.getDate();
      const newAge = hasBirthdayPassed
        ? today.getFullYear() - birthDate.getFullYear()
        : today.getFullYear() - birthDate.getFullYear() - 1;

      await db
        .update(Member)
        .set({
          ...updateData,
          resumeUrl: resume,
          dob: dob,
          age: newAge,
        })
        .where(eq(Member.id, id));
    }),

  deleteMember: adminProcedure
    .input(InsertMemberSchema.pick({ id: true }))
    .mutation(async ({ input }) => {
      if (!input.id) {
        throw new TRPCError({
          message: "Member ID is required to delete a member!",
          code: "BAD_REQUEST",
        });
      }
      await db.delete(Member).where(eq(Member.id, input.id));
    }),

  getMember: protectedProcedure.query(async ({ ctx }) => {
    const member = await db
      .select()
      .from(Member)
      .where(eq(Member.userId, ctx.session.user.id));

    if (member.length === 0) return null; // Can't return undefined in trpc

    return member[member.length - 1];
  }),

  getDuesPayingMembers: protectedProcedure.query(async () => {
    const duesPayingMembers = await db
      .select()
      .from(Member)
      .where(
        exists(
          db
            .select()
            .from(DuesPayment)
            .where(eq(DuesPayment.memberId, Member.id)),
        ),
      );

    return duesPayingMembers;
  }),

  createDuesPayingMember: adminProcedure
    .input(InsertMemberSchema.pick({ id: true }))
    .mutation(async ({ input }) => {
      if (!input.id) {
        throw new TRPCError({
          message: "Member ID is required to update dues paying status!",
          code: "BAD_REQUEST",
        });
      }
      await db.insert(DuesPayment).values({
        memberId: input.id,
        amount: DUES_PAYMENT as number,
        paymentDate: new Date(),
        year: new Date().getFullYear(),
      });
    }),

  deleteDuesPayingMember: adminProcedure
    .input(InsertMemberSchema.pick({ id: true }))
    .mutation(async ({ input }) => {
      if (!input.id) {
        throw new TRPCError({
          message: "Member ID is required to update dues paying status!",
          code: "BAD_REQUEST",
        });
      }
      await db.delete(DuesPayment).where(eq(DuesPayment.memberId, input.id));
    }),

  clearAllDues: adminProcedure.mutation(async () => {
    await db.delete(DuesPayment);
  }),

  getEvents: protectedProcedure.query(async ({ ctx }) => {
    const events = await db
      .select({
        ...getTableColumns(Event),
        numAttended: count(Member.id),
      })
      .from(Event)
      .leftJoin(EventAttendee, eq(Event.id, EventAttendee.eventId))
      .leftJoin(Member, eq(EventAttendee.memberId, Member.id))
      .where(
        and(eq(Member.userId, ctx.session.user.id), isNull(Event.hackathonId)),
      )
      .groupBy(Event.id);

    return events;
  }),

  getMembers: protectedProcedure.query(async () => {
    return db.query.Member.findMany();
  }),

  eventCheckIn: adminProcedure
    .input(
      z.object({
        userId: z.string(),
        eventId: z.string(),
        eventPoints: z.number(),
      }),
    )
    .mutation(async ({ input }) => {
      const member = await db.query.Member.findFirst({
        where: (t, { eq }) => eq(t.userId, input.userId),
      });

      if (!member) {
        return;
      }

      const duplicates = await db
        .select()
        .from(EventAttendee)
        .where(
          and(
            eq(EventAttendee.memberId, member.id),
            eq(EventAttendee.eventId, input.eventId),
          ),
        );

      if (duplicates.length > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `${member.firstName} ${member.lastName} is already checked in for the event`,
        });
      }

      const eventAttendee = {
        memberId: member.id,
        eventId: input.eventId,
      };
      await db.insert(EventAttendee).values(eventAttendee);

      // Increment the points for the member
      await db
        .update(Member)
        .set({
          points: sql`${Member.points} + ${input.eventPoints}`, // Ensure input.eventPoints is parsed as a number
        })
        .where(eq(Member.id, member.id));

      return {
        message: `${member.firstName} ${member.lastName} has been checked in for the event`,
      };
    }),
} satisfies TRPCRouterRecord;
