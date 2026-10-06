import type { WebSocket } from "ws";
import type { FluxoraEventEnvelope } from "@fluxora/shared-types";

export interface ConnectedClient {
  ws: WebSocket;
  userId: string;
  organizationId: string;
}

export class WebSocketHub {
  private readonly clientsByOrg = new Map<string, Set<ConnectedClient>>();

  register(client: ConnectedClient): () => void {
    let orgClients = this.clientsByOrg.get(client.organizationId);
    if (!orgClients) {
      orgClients = new Set();
      this.clientsByOrg.set(client.organizationId, orgClients);
    }
    orgClients.add(client);

    return () => {
      this.unregister(client);
    };
  }

  unregister(client: ConnectedClient): void {
    const orgClients = this.clientsByOrg.get(client.organizationId);
    if (orgClients) {
      orgClients.delete(client);
      if (orgClients.size === 0) {
        this.clientsByOrg.delete(client.organizationId);
      }
    }
  }

  broadcast(envelope: FluxoraEventEnvelope): number {
    const orgClients = this.clientsByOrg.get(envelope.organization_id);
    if (!orgClients || orgClients.size === 0) {
      return 0;
    }

    const payload = JSON.stringify(envelope);
    let sentCount = 0;

    for (const client of orgClients) {
      if (client.ws.readyState === 1 /* WebSocket.OPEN */) {
        try {
          client.ws.send(payload);
          sentCount += 1;
        } catch {
          // Failed socket send will be cleaned up on close/error
        }
      }
    }

    return sentCount;
  }

  getClientCount(organizationId?: string): number {
    if (organizationId !== undefined) {
      return this.clientsByOrg.get(organizationId)?.size ?? 0;
    }
    let total = 0;
    for (const set of this.clientsByOrg.values()) {
      total += set.size;
    }
    return total;
  }
}

