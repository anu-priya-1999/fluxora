import { getPool } from "@fluxora/db";
import { parseFluxoraEventEnvelope } from "@fluxora/shared-types";
import type pg from "pg";

import type { WebSocketHub } from "./hub.ts";

export const FLUXORA_EVENTS_CHANNEL = "fluxora_events";

export class PostgresEventListener {
  private client: pg.PoolClient | null = null;
  private isRunning = false;
  private readonly hub: WebSocketHub;
  private readonly pool: pg.Pool;

  constructor(hub: WebSocketHub, pool?: pg.Pool) {
    this.hub = hub;
    this.pool = pool ?? getPool();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;

    try {
      this.client = await this.pool.connect();
      await this.client.query(`LISTEN ${FLUXORA_EVENTS_CHANNEL}`);

      this.client.on("notification", (msg) => {
        if (msg.channel === FLUXORA_EVENTS_CHANNEL && msg.payload) {
          try {
            const raw = JSON.parse(msg.payload) as unknown;
            const envelope = parseFluxoraEventEnvelope(raw);
            if (envelope !== null) {
              this.hub.broadcast(envelope);
            }
          } catch (error) {
            console.error("[ws.listener] failed to process notification:", error);
          }
        }
      });

      this.client.on("error", (error) => {
        console.error("[ws.listener] postgres notification client error:", error);
      });
    } catch (error) {
      this.isRunning = false;
      if (this.client) {
        this.client.release();
        this.client = null;
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    this.isRunning = false;

    if (this.client) {
      try {
        await this.client.query(`UNLISTEN ${FLUXORA_EVENTS_CHANNEL}`).catch(() => undefined);
      } finally {
        this.client.release();
        this.client = null;
      }
    }
  }

  get active(): boolean {
    return this.isRunning;
  }
}

