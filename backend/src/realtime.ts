import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import { verifyAuthToken } from "./auth/jwt.js";
import { hasPermission, PERMISSIONS, USER_ROLES, type Permission, type UserRole } from "./auth/roles.js";
import { prisma } from "./db/prisma.js";

export type RealtimeUser = {
  id: string;
  role: UserRole;
  permissions: readonly Permission[];
  tokenIssuedAt: number;
  tokenExpiresAt: number;
};

export type RealtimeLocation = {
  id: string;
  latitude: number;
  longitude: number;
  observedAt: Date;
  accuracyMeters: number | null;
  altitudeMeters: number | null;
  source: string;
  eventId: string | null;
  expeditionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CargoUpdate = {
  id: string;
  expeditionId: string;
  location: string | null;
  currentLocation?: RealtimeLocation | null;
  status: string;
  updatedAt: Date;
};

export type LocationUpdate = {
  entityType: "personnel" | "cargo" | "emergency";
  entityId: string;
  expeditionId: string;
  location: RealtimeLocation;
};

export type PersonnelLocationUpdate = {
  personnelId: string;
  expeditionId: string;
  location: RealtimeLocation;
};

export type AssetStatusChange = {
  assetId: string;
  expeditionId: string;
  status: string;
  updatedAt: Date;
};

export type ShipmentMilestoneAdded = {
  shipmentId: string;
  expeditionId: string;
  milestone: {
    id: string;
    type: string;
    occurredAt: Date;
  };
};

export type AlertUpdate = {
  id: string;
  expeditionId: string;
  title: string;
  message: string;
  severity: string;
  status: string;
  location: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

export type EmergencyCreated = Omit<AlertUpdate, "location">;

export type RoomAcknowledgement = { ok: true } | { ok: false; error: string };

export interface ClientToServerEvents {
  "expedition:join": (payload: { expeditionId: string }, acknowledge?: (result: RoomAcknowledgement) => void) => void;
  "expedition:leave": (payload: { expeditionId: string }, acknowledge?: (result: RoomAcknowledgement) => void) => void;
}

export interface ServerToClientEvents {
  "cargo.updated": (update: CargoUpdate) => void;
  "cargo:update": (update: CargoUpdate) => void;
  "location.updated": (update: LocationUpdate) => void;
  "personnel:location_update": (update: PersonnelLocationUpdate) => void;
  "asset:status_change": (update: AssetStatusChange) => void;
  "shipment:milestone_added": (update: ShipmentMilestoneAdded) => void;
  "emergency.created": (update: EmergencyCreated) => void;
  "alert:new": (update: AlertUpdate) => void;
}

interface InterServerEvents {}

interface SocketData {
  user: RealtimeUser;
}

type RealtimeSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type RealtimeServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

const expeditionRoomPayloadSchema = z.object({ expeditionId: z.string().trim().min(1).max(100) }).strict();
const MAX_TIMEOUT = 2_147_000_000;

let io: RealtimeServer | undefined;

export const userRoom = (userId: string) => `user:${userId}`;
export const roleRoom = (role: UserRole) => `role:${role}`;
export const expeditionRoom = (expeditionId: string) => `expedition:${expeditionId}`;
export const expeditionRoleRoom = (expeditionId: string, role: UserRole) => `${expeditionRoom(expeditionId)}:role:${role}`;

async function joinExpeditionRooms(socket: RealtimeSocket, expeditionId: string) {
  await socket.join([expeditionRoom(expeditionId), expeditionRoleRoom(expeditionId, socket.data.user.role)]);
}

async function leaveExpeditionRooms(socket: RealtimeSocket, expeditionId: string) {
  await Promise.all([
    socket.leave(expeditionRoom(expeditionId)),
    socket.leave(expeditionRoleRoom(expeditionId, socket.data.user.role)),
  ]);
}

function registerRoomHandlers(socket: RealtimeSocket) {
  socket.on("expedition:join", (payload, acknowledge) => {
    const respond = (result: RoomAcknowledgement) => acknowledge?.(result);
    const parsed = expeditionRoomPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      respond({ ok: false, error: "Invalid expedition ID" });
      return;
    }
    if (!hasPermission(socket.data.user.role, "expeditions.read")) {
      respond({ ok: false, error: "Insufficient permissions" });
      return;
    }
    void prisma.expedition.findUnique({ where: { id: parsed.data.expeditionId }, select: { id: true } })
      .then(async (expedition) => {
        if (!expedition) {
          respond({ ok: false, error: "Expedition not found or inaccessible" });
          return;
        }
        await joinExpeditionRooms(socket, parsed.data.expeditionId);
        respond({ ok: true });
      })
      .catch(() => respond({ ok: false, error: "Unable to authorize expedition room" }));
  });

  socket.on("expedition:leave", (payload, acknowledge) => {
    const parsed = expeditionRoomPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      acknowledge?.({ ok: false, error: "Invalid expedition ID" });
      return;
    }
    void leaveExpeditionRooms(socket, parsed.data.expeditionId)
      .then(() => acknowledge?.({ ok: true }))
      .catch(() => acknowledge?.({ ok: false, error: "Unable to leave expedition room" }));
  });
}

export function createRealtimeServer(httpServer: HttpServer) {
  io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL ?? "http://localhost:5173",
    },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string") {
      next(new Error("Authentication required"));
      return;
    }
    try {
      const verified = verifyAuthToken(token);
      socket.data.user = {
        id: verified.sub,
        role: verified.role,
        permissions: PERMISSIONS.filter((permission) => hasPermission(verified.role, permission)),
        tokenIssuedAt: verified.iat,
        tokenExpiresAt: verified.exp,
      };
      void Promise.resolve(socket.join([userRoom(verified.sub), roleRoom(verified.role)]))
        .then(() => next())
        .catch(() => next(new Error("Unable to initialize socket authorization")));
    } catch {
      next(new Error("Invalid or expired token"));
    }
  });

  io.on("connection", (socket) => {
    registerRoomHandlers(socket);
    const remainingMs = Math.max(0, socket.data.user.tokenExpiresAt * 1000 - Date.now());
    const expiryTimer = setTimeout(() => socket.disconnect(true), Math.min(remainingMs, MAX_TIMEOUT));
    socket.once("disconnect", () => clearTimeout(expiryTimer));
  });

  return io;
}

export function broadcastCargoUpdate(update: CargoUpdate) {
  if (!io) return;
  for (const role of USER_ROLES) {
    if (!hasPermission(role, "cargo.read")) continue;
    const roleUpdate = hasPermission(role, "locations.read")
      ? update
      : { ...update, location: null, currentLocation: null };
    const room = expeditionRoleRoom(update.expeditionId, role);
    io.to(room).emit("cargo.updated", roleUpdate);
    io.to(room).emit("cargo:update", roleUpdate);
  }
}

export function broadcastLocationUpdated(update: LocationUpdate) {
  if (!io) return;
  for (const role of USER_ROLES) {
    if (!hasPermission(role, "locations.read")) continue;
    io.to(expeditionRoleRoom(update.expeditionId, role)).emit("location.updated", update);
  }
}

export function broadcastPersonnelLocationUpdate(update: PersonnelLocationUpdate) {
  if (!io) return;
  for (const role of USER_ROLES) {
    if (!hasPermission(role, "locations.read")) continue;
    io.to(expeditionRoleRoom(update.expeditionId, role)).emit("personnel:location_update", update);
  }
}

export function broadcastAssetStatusChange(update: AssetStatusChange) {
  if (!io) return;
  const payload: AssetStatusChange = {
    assetId: update.assetId,
    expeditionId: update.expeditionId,
    status: update.status,
    updatedAt: update.updatedAt,
  };
  for (const role of USER_ROLES) {
    if (!hasPermission(role, "assets.read")) continue;
    io.to(expeditionRoleRoom(update.expeditionId, role)).emit("asset:status_change", payload);
  }
}

export function broadcastShipmentMilestoneAdded(update: ShipmentMilestoneAdded) {
  if (!io) return;
  const payload: ShipmentMilestoneAdded = {
    shipmentId: update.shipmentId,
    expeditionId: update.expeditionId,
    milestone: {
      id: update.milestone.id,
      type: update.milestone.type,
      occurredAt: update.milestone.occurredAt,
    },
  };
  for (const role of USER_ROLES) {
    if (!hasPermission(role, "expeditions.read")) continue;
    io.to(expeditionRoleRoom(update.expeditionId, role)).emit("shipment:milestone_added", payload);
  }
}

export function broadcastAlertNew(update: AlertUpdate) {
  if (!io) return;
  const legacyUpdate: AlertUpdate = {
    id: update.id,
    expeditionId: update.expeditionId,
    title: update.title,
    message: update.message,
    severity: update.severity,
    status: update.status,
    location: update.location,
    createdAt: update.createdAt,
    resolvedAt: update.resolvedAt,
  };
  io.to(roleRoom("ADMIN")).to(roleRoom("COORDINATOR")).emit("alert:new", legacyUpdate);
  const safeUpdate: EmergencyCreated = {
    id: update.id,
    expeditionId: update.expeditionId,
    title: update.title,
    message: update.message,
    severity: update.severity,
    status: update.status,
    createdAt: update.createdAt,
    resolvedAt: update.resolvedAt,
  };
  for (const role of USER_ROLES) {
    if (!hasPermission(role, "emergency.read")) continue;
    io.to(expeditionRoleRoom(update.expeditionId, role)).emit("emergency.created", safeUpdate);
  }
}

export function getRealtimeServer() {
  return io;
}