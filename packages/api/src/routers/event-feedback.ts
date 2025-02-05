import type { TRPCRouterRecord } from "@trpc/server";
import { TRPCError } from "@trpc/server";

import {
    and,
  } from "@forge/db";

import { db } from "@forge/db/client";
import { log } from "../utils";
import { protectedProcedure } from "../trpc";
import { EventFeedback, InsertEventFeedbackSchema } from "@forge/db/schemas/knight-hacks";

export const eventFeedbackRouter = {
    createEventFeedback: protectedProcedure
        .input(InsertEventFeedbackSchema)
        .mutation(async ({ input, ctx }) => {
            const existingFeedback = await db
                .query.EventFeedback.findFirst({
                    where: (t, { eq }) => and(eq(t.memberId, input.memberId), 
                        eq(t.eventId, input.eventId))
                });

            if (existingFeedback) {
                throw new TRPCError({
                    message: "Cannot give feedback more than once for this event!",
                    code: "FORBIDDEN",
                });
            }

            const existingEvent = await db
                .query.Event.findFirst({
                    where: (t, { eq }) => eq(t.id, input.eventId)
                });

            const existingMember = await db
                .query.Member.findFirst({
                    where: (t, { eq }) => eq(t.id, input.memberId)
                });

            if (!existingEvent) {
                throw new TRPCError({
                    message: "Event not found!",
                    code: "NOT_FOUND",
                });
            }

            if (!existingMember) {
                throw new TRPCError({
                    message: "Member not found!",
                    code: "NOT_FOUND",
                });
            }

            await db.insert(EventFeedback).values({...input});

            await log({
                title: "Feedback Given",
                message: `${existingMember.firstName} ${existingMember.lastName} gave feedback for ${existingEvent.name}!`,
                color: "tk_blue",
                userId: ctx.session.user.discordUserId,
            });
        }),
} satisfies TRPCRouterRecord;