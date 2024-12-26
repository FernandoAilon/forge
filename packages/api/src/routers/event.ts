import type { TRPCRouterRecord } from "@trpc/server";
import { APIExternalGuildScheduledEvent, Routes } from "discord-api-types/v10";

import { EVENT_POINTS, KNIGHTHACKS_GUILD_ID } from "@forge/consts/knight-hacks";
import { desc, eq } from "@forge/db";
import { db } from "@forge/db/client";
import { Event, InsertEventSchema } from "@forge/db/schemas/knight-hacks";

import { adminProcedure } from "../trpc";
import { discord } from "../utils";

export const eventRouter = {
  getEvents: adminProcedure.query(async () => {
    return db.query.Event.findMany({
      orderBy: [desc(Event.datetime)],
    });
  }),
  createEvent: adminProcedure
    .input(InsertEventSchema.omit({ id: true, discordId: true }))
    .mutation(async ({ input }) => {
      // Step 1: Make the event in Discord
      let eventId;
      try {
        const startDatetime = new Date(input.datetime);
        const startIsoTimestamp = startDatetime.toISOString();
        const endDatetime = new Date(
          startDatetime.getTime() + 3 * 60 * 60 * 1000,
        );
        const endIsoTimestamp = endDatetime.toISOString();

        const response = (await discord.post(
          Routes.guildScheduledEvents(KNIGHTHACKS_GUILD_ID),
          {
            body: {
              description: input.description,
              name: input.name,
              privacy_level: 2,
              scheduled_start_time: startIsoTimestamp,
              scheduled_end_time: endIsoTimestamp,
              entity_type: 3,
              entity_metadata: {
                location: input.location,
              },
            },
          },
        )) as APIExternalGuildScheduledEvent;
        eventId = response.id;
        console.log(JSON.stringify(response, null, 2));
      } catch (error) {
        console.error(JSON.stringify(error, null, 2));
      }

      // Step 2: Insert the event into the database with the discord id.
      if (!eventId) {
        throw new Error("Failed to create event in Discord");
      }

      await db.insert(Event).values({
        ...input,
        points: EVENT_POINTS[input.tag] || 0,
        discordId: eventId,
      });
    }),
  updateEvent: adminProcedure
    .input(InsertEventSchema)
    .mutation(async ({ input }) => {
      if (!input.id) {
        throw new Error("Event ID is required to update an event");
      }
      await db.update(Event).set(input).where(eq(Event.id, input.id));
    }),
  deleteEvent: adminProcedure
    .input(InsertEventSchema.pick({ id: true }))
    .mutation(async ({ input }) => {
      if (!input.id) {
        throw new Error("Event ID is required to delete an event");
      }
      await db.delete(Event).where(eq(Event.id, input.id));
    }),
} satisfies TRPCRouterRecord;
