import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requirePermission } from "../../auth/middleware.js";
import type { Permission } from "../../auth/roles.js";
import { broadcastCargoUpdate, broadcastLocationUpdated, broadcastPersonnelLocationUpdate } from "../../realtime.js";
import { prisma } from "../../db/prisma.js";
import { formatLegacyLocation, getCurrentLocation, getLocationHistory, LocationError, recordLocation } from "./service.js";
import { locationEntityTypeSchema, locationInputSchema } from "./validation.js";
import type { LocationEntityType } from "./types.js";

const router = Router();
const paginationSchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });
const permissions = {
  personnel: { read: "locations.read", update: "personnel.manage" },
  cargo: { read: "locations.read", update: "cargo.manage" },
  emergency: { read: "locations.read", update: "emergency.manage" },
} as const satisfies Record<LocationEntityType, { read: Permission; update: Permission }>;

function authorizeLocation(action: "read" | "update") {
  return (request: Request, response: Response, next: () => void) => {
    const parsed = locationEntityTypeSchema.safeParse(request.params.entityType);
    if (!parsed.success) {
      response.status(400).json({ error: "Invalid entity type" });
      return;
    }
    requirePermission(permissions[parsed.data][action])(request, response, next);
  };
}

const asyncRoute = (handler: (request: Request, response: Response) => Promise<void>) =>
  (request: Request, response: Response) => {
    void handler(request, response).catch((error: unknown) => {
      if (error instanceof LocationError) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: "Internal server error" });
    });
  };

function parseEntityType(request: Request, response: Response) {
  const result = locationEntityTypeSchema.safeParse(request.params.entityType);
  if (!result.success) {
    response.status(400).json({ error: "Invalid entity type" });
    return undefined;
  }
  return result.data;
}

function parseEntityId(request: Request, response: Response) {
  const entityId = request.params.entityId;
  if (typeof entityId !== "string" || !entityId) {
    response.status(400).json({ error: "Invalid entity id" });
    return undefined;
  }
  return entityId;
}

router.get("/:entityType/:entityId", authorizeLocation("read"), asyncRoute(async (request, response) => {
  const entityType = parseEntityType(request, response);
  const entityId = parseEntityId(request, response);
  if (!entityType || !entityId) return;
  const data = await getCurrentLocation(entityType, entityId);
  response.json({ data });
}));

router.get("/:entityType/:entityId/history", authorizeLocation("read"), asyncRoute(async (request, response) => {
  const entityType = parseEntityType(request, response);
  const entityId = parseEntityId(request, response);
  const pagination = paginationSchema.safeParse(request.query);
  if (!entityType || !entityId) return;
  if (!pagination.success) {
    response.status(400).json({ error: "Validation failed", details: pagination.error.flatten() });
    return;
  }
  response.json(await getLocationHistory(entityType, entityId, pagination.data.page, pagination.data.pageSize));
}));

router.post("/:entityType/:entityId", authorizeLocation("update"), asyncRoute(async (request, response) => {
  const entityType = parseEntityType(request, response);
  const entityId = parseEntityId(request, response);
  const input = locationInputSchema.safeParse(request.body);
  if (!entityType || !entityId) return;
  if (!input.success) {
    response.status(400).json({ error: "Validation failed", details: input.error.flatten() });
    return;
  }
  const result = await recordLocation(entityType, entityId, input.data);
  if (!result.replayed) {
    broadcastLocationUpdated({ entityType, entityId, expeditionId: result.location.expeditionId!, location: result.location });
    if (entityType === "personnel") {
      broadcastPersonnelLocationUpdate({ personnelId: entityId, expeditionId: result.location.expeditionId!, location: result.location });
    }
  }
  if (entityType === "cargo" && !result.replayed) {
    const cargo = await prisma.cargoItem.findUnique({ where: { id: entityId }, select: { expeditionId: true, status: true, updatedAt: true } });
    if (cargo) {
      broadcastCargoUpdate({ id: entityId, expeditionId: cargo.expeditionId, location: formatLegacyLocation(result.location), currentLocation: result.location, status: cargo.status, updatedAt: cargo.updatedAt });
    }
  }
  response.status(result.replayed ? 200 : 201).json({ data: result.location });
}));

export default router;