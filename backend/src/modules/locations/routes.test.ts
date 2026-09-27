import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signAuthToken } from "../../auth/jwt.js";
import * as realtime from "../../realtime.js";

const database = vi.hoisted(() => ({
  personnel: { findUnique: vi.fn() },
  cargoItem: { findUnique: vi.fn(), update: vi.fn() },
  emergencyAlert: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  location: { findUnique: vi.fn(), create: vi.fn() },
  personnelLocationHistory: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
  cargoLocationHistory: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
  emergencyLocationHistory: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("../../db/prisma.js", () => ({ prisma: database }));

import { app } from "../../app.js";

const point = {
  id: "loc-1", latitude: 78.12345678, longitude: -12.45678901,
  observedAt: new Date("2026-09-26T12:00:00.000Z"), accuracyMeters: null, altitudeMeters: null,
  source: "MANUAL", eventId: null, expeditionId: "exp-1", createdAt: new Date(), updatedAt: new Date(),
};

function token(role: "ADMIN" | "FIELD_PERSONNEL") {
  return `Bearer ${signAuthToken({ sub: "user-1", role })}`;
}

function transaction() {
  return {
    personnel: { findUnique: vi.fn().mockResolvedValue({ id: "person-1", expeditionId: "exp-1", currentLocation: null }), update: vi.fn() },
    cargoItem: { findUnique: vi.fn(), update: vi.fn() },
    emergencyAlert: { findUnique: vi.fn().mockResolvedValue({ id: "alert-1", expeditionId: "exp-1", currentLocation: null }), create: vi.fn().mockResolvedValue({ id: "alert-1", expeditionId: "exp-1", location: "South Pole" }), update: vi.fn() },
    location: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ ...point, id: "loc-new" }) },
    personnelLocationHistory: { findUnique: vi.fn(), create: vi.fn() },
    cargoLocationHistory: { findUnique: vi.fn(), create: vi.fn() },
    emergencyLocationHistory: { findUnique: vi.fn(), create: vi.fn() },
  };
}

describe("location API authorization", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "location-routes-test-secret";
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("rejects unauthenticated location reads", async () => {
    const response = await request(app).get("/api/locations/personnel/person-1");
    expect(response.status).toBe(401);
  });

  it("denies precise location reads to FIELD_PERSONNEL", async () => {
    const response = await request(app).get("/api/locations/personnel/person-1").set("Authorization", token("FIELD_PERSONNEL"));
    expect(response.status).toBe(403);
    expect(database.personnel.findUnique).not.toHaveBeenCalled();
  });

  it("allows an authorized role to read the current structured location", async () => {
    vi.mocked(database.personnel.findUnique).mockResolvedValue({ id: "person-1", currentLocation: point } as never);
    const response = await request(app).get("/api/locations/personnel/person-1").set("Authorization", token("ADMIN"));
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ latitude: 78.12345678, longitude: -12.45678901 });
  });

  it("allows an authorized role to retrieve location history", async () => {
    vi.mocked(database.personnelLocationHistory.findMany).mockResolvedValue([{ id: "history-1", location: point } as never]);
    vi.mocked(database.personnelLocationHistory.count).mockResolvedValue(1);
    vi.mocked(database.personnel.findUnique).mockResolvedValue({ id: "person-1" } as never);
    const response = await request(app).get("/api/locations/personnel/person-1/history").set("Authorization", token("ADMIN"));
    expect(response.status).toBe(200);
    expect(response.body.data[0]).toMatchObject({ latitude: 78.12345678, observedAt: point.observedAt.toISOString() });
    expect(response.body.pagination.total).toBe(1);
  });

  it("allows an authorized role to record a location", async () => {
    const locationBroadcast = vi.spyOn(realtime, "broadcastLocationUpdated");
    const personnelLocationBroadcast = vi.spyOn(realtime, "broadcastPersonnelLocationUpdate");
    const tx = transaction();
    const eventId = "3d0e2547-62ca-4339-b6b2-6c0df52a2260";
    tx.location.findUnique.mockResolvedValueOnce(null).mockResolvedValue({ ...point, id: "loc-new", eventId });
    tx.location.create.mockResolvedValue({ ...point, id: "loc-new", eventId });
    tx.personnelLocationHistory.findUnique.mockResolvedValue({ id: "history-1" });
    database.$transaction.mockImplementation(async (operation: (transaction: unknown) => unknown) => operation(tx));

    const postLocation = () => request(app).post("/api/locations/personnel/person-1").set("Authorization", token("ADMIN")).send({
      latitude: 78.12345678,
      longitude: -12.45678901,
      observedAt: "2026-09-26T12:00:00.000Z",
      eventId,
    });
    const first = await postLocation();
    const retry = await postLocation();

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(first.body.data.expeditionId).toBe("exp-1");
    expect(tx.location.create).toHaveBeenCalledOnce();
    expect(tx.personnelLocationHistory.create).toHaveBeenCalledOnce();
    expect(personnelLocationBroadcast).toHaveBeenCalledWith(expect.objectContaining({
      personnelId: "person-1",
      expeditionId: "exp-1",
      location: expect.objectContaining({ latitude: 78.12345678, longitude: -12.45678901, eventId }),
    }));
    expect(locationBroadcast).toHaveBeenCalledWith(expect.objectContaining({
      entityType: "personnel", entityId: "person-1", expeditionId: "exp-1",
      location: expect.objectContaining({ latitude: 78.12345678 }),
    }));
  });

  it("denies FIELD_PERSONNEL location updates before persistence", async () => {
    const response = await request(app).post("/api/locations/personnel/person-1").set("Authorization", token("FIELD_PERSONNEL")).send({ latitude: 1, longitude: 2 });
    expect(response.status).toBe(403);
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("rejects out-of-range coordinates before starting a transaction", async () => {
    const response = await request(app).post("/api/locations/personnel/person-1").set("Authorization", token("ADMIN")).send({
      latitude: 91, longitude: 0, eventId: "3d0e2547-62ca-4339-b6b2-6c0df52a2260",
    });
    expect(response.status).toBe(400);
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("preserves existing free-text cargo location updates", async () => {
    const before = { id: "cargo-1", location: null, status: "IN_TRANSIT", updatedAt: new Date() };
    const after = { ...before, location: "South Pole" };
    vi.mocked(database.cargoItem.findUnique).mockResolvedValue(before as never);
    vi.mocked(database.cargoItem.update).mockResolvedValue(after as never);
    const response = await request(app).post("/api/cargo-items/cargo-1/location").set("Authorization", token("ADMIN")).send({ location: "South Pole" });

    expect(response.status).toBe(200);
    expect(response.body.location).toBe("South Pole");
    expect(database.cargoItem.update).toHaveBeenCalledWith({ where: { id: "cargo-1" }, data: { location: "South Pole", currentLocationId: null } });
  });

  it("preserves legacy coordinate retries without creating structured history when no event ID is supplied", async () => {
    const locationBroadcast = vi.spyOn(realtime, "broadcastLocationUpdated");
    const before = { id: "cargo-1", location: null, currentLocationId: "old-location", status: "IN_TRANSIT", updatedAt: new Date() };
    const after = { ...before, location: "-77.85,166.67", currentLocationId: null };
    vi.mocked(database.cargoItem.findUnique).mockResolvedValue(before as never);
    vi.mocked(database.cargoItem.update).mockResolvedValue(after as never);
    const postLegacyLocation = () => request(app).post("/api/cargo-items/cargo-1/location").set("Authorization", token("ADMIN")).send({ location: "-77.85,166.67" });

    const first = await postLegacyLocation();
    const retry = await postLegacyLocation();

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(database.cargoItem.update).toHaveBeenCalledTimes(2);
    expect(database.cargoItem.update).toHaveBeenCalledWith({ where: { id: "cargo-1" }, data: { location: "-77.85,166.67", currentLocationId: null } });
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(database.location.create).not.toHaveBeenCalled();
    expect(database.cargoLocationHistory.create).not.toHaveBeenCalled();
    expect(locationBroadcast).not.toHaveBeenCalled();
  });

  it("keeps legacy cargo requests with a stable event ID idempotent", async () => {
    const tx = transaction();
    const eventId = "3d0e2547-62ca-4339-b6b2-6c0df52a2260";
    const storedPoint = { ...point, id: "loc-cargo", eventId };
    tx.cargoItem.findUnique.mockResolvedValue({ id: "cargo-1", expeditionId: "exp-1", currentLocation: null });
    tx.location.findUnique.mockResolvedValueOnce(null).mockResolvedValue(storedPoint);
    tx.location.create.mockResolvedValue(storedPoint);
    tx.cargoLocationHistory.findUnique.mockResolvedValue({ id: "history-1" });
    database.$transaction.mockImplementation(async (operation: (transaction: unknown) => unknown) => operation(tx));
    vi.mocked(database.cargoItem.findUnique).mockResolvedValue({ id: "cargo-1", status: "IN_TRANSIT", updatedAt: new Date() } as never);
    const postLegacyLocation = () => request(app).post("/api/cargo-items/cargo-1/location").set("Authorization", token("ADMIN")).send({
      location: "-77.85,166.67", eventId,
    });

    const first = await postLegacyLocation();
    const retry = await postLegacyLocation();

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(tx.location.create).toHaveBeenCalledOnce();
    expect(tx.cargoLocationHistory.create).toHaveBeenCalledOnce();
  });

  it("preserves existing emergency alert location strings", async () => {
    const alert = { id: "alert-1", expeditionId: "exp-1", location: "South Pole", createdAt: new Date(), currentLocation: null };
    const tx = transaction();
    database.$transaction.mockImplementation(async (operation: (transaction: unknown) => unknown) => operation(tx));
    vi.mocked(database.emergencyAlert.findUnique).mockResolvedValue(alert as never);
    const response = await request(app).post("/api/alerts").set("Authorization", token("ADMIN")).send({
      expeditionId: "exp-1", title: "Alert", message: "Legacy location format", location: "South Pole",
    });

    expect(response.status).toBe(201);
    expect(response.body.location).toBe("South Pole");
    expect(tx.emergencyAlert.create).toHaveBeenCalledWith({ data: expect.objectContaining({ location: "South Pole" }) });
  });

  it("stores structured SOS coordinates and returns current location", async () => {
    const gpsLocation = { ...point, id: "loc-gps", source: "GPS" };
    const tx = transaction();
    tx.emergencyAlert.create.mockResolvedValue({ id: "alert-1", expeditionId: "exp-1", location: null });
    tx.location.create.mockResolvedValue(gpsLocation);
    vi.mocked(database.emergencyAlert.findUnique).mockResolvedValue({ id: "alert-1", expeditionId: "exp-1", location: "78.12345678,-12.45678901", currentLocation: gpsLocation } as never);
    database.$transaction.mockImplementation(async (operation: (transaction: unknown) => unknown) => operation(tx));
    const response = await request(app).post("/api/alerts").set("Authorization", token("ADMIN")).send({
      expeditionId: "exp-1", title: "SOS", message: "Need assistance", location: "78.12345678,-12.45678901",
      locationCoordinates: { latitude: 78.12345678, longitude: -12.45678901, source: "GPS", eventId: "3d0e2547-62ca-4339-b6b2-6c0df52a2260", observedAt: "2026-09-26T12:00:00.000Z" },
    });

    expect(response.status).toBe(201);
    expect(response.body.currentLocation).toMatchObject({ latitude: 78.12345678, source: "GPS", expeditionId: "exp-1" });
    expect(tx.emergencyLocationHistory.create).toHaveBeenCalledOnce();
  });

  it("redacts precise structured SOS coordinates from callers without locations.read", async () => {
    const tx = transaction();
    tx.emergencyAlert.create.mockResolvedValue({ id: "alert-1", expeditionId: "exp-1", location: null });
    tx.location.create.mockResolvedValue({ ...point, id: "loc-gps", source: "GPS" });
    vi.mocked(database.emergencyAlert.findUnique).mockResolvedValue({ id: "alert-1", expeditionId: "exp-1", location: "78.12345678,-12.45678901", currentLocation: { ...point, source: "GPS" } } as never);
    database.$transaction.mockImplementation(async (operation: (transaction: unknown) => unknown) => operation(tx));
    const response = await request(app).post("/api/alerts").set("Authorization", token("FIELD_PERSONNEL")).send({
      expeditionId: "exp-1", title: "SOS", message: "Need assistance", location: "78.12345678,-12.45678901",
      locationCoordinates: { latitude: 78.12345678, longitude: -12.45678901, source: "GPS", eventId: "6af2b45d-f2c8-4e38-9e87-6ed3db8b7be7", observedAt: "2026-09-26T12:00:00.000Z" },
    });

    expect(response.status).toBe(201);
    expect(response.body.currentLocation).toBeNull();
    expect(response.body.location).toBeNull();
  });

  it("returns the existing SOS for a replayed location event", async () => {
    const priorAlert = { id: "alert-prior", expeditionId: "exp-1", location: "78,-12", currentLocation: point };
    vi.mocked(database.location.findUnique).mockResolvedValue({ emergencyHistory: [{ emergencyAlert: priorAlert }] } as never);
    const response = await request(app).post("/api/alerts").set("Authorization", token("FIELD_PERSONNEL")).send({
      expeditionId: "exp-1", title: "SOS", message: "Retry", location: "78,-12",
      locationCoordinates: { latitude: 78, longitude: -12, eventId: "3d0e2547-62ca-4339-b6b2-6c0df52a2260" },
    });

    expect(response.status).toBe(200);
    expect(response.body.id).toBe("alert-prior");
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("returns the original SOS for a repeated offline operation ID without creating another alert", async () => {
    const operationId = "965f92cf-7dc2-4c32-a6e1-64612944c8e3";
    const createdAlert = {
      id: "alert-operation-1", operationId, createdById: "user-1", expeditionId: "exp-1", title: "SOS",
      message: "Offline SOS", severity: "CRITICAL", status: "OPEN", location: null, resolvedAt: null,
      createdAt: new Date(), updatedAt: new Date(), currentLocation: null,
    };
    const tx = transaction();
    tx.emergencyAlert.create.mockResolvedValue(createdAlert as never);
    database.$transaction.mockImplementation(async (operation: (transaction: unknown) => unknown) => operation(tx));
    vi.mocked(database.emergencyAlert.findUnique)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(createdAlert as never)
      .mockResolvedValueOnce(createdAlert as never);
    const postSos = () => request(app).post("/api/alerts").set("Authorization", token("ADMIN")).send({
      operationId, expeditionId: "exp-1", title: "SOS", message: "Offline SOS", severity: "CRITICAL", location: null,
    });

    const first = await postSos();
    const retry = await postSos();

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(first.body.id).toBe("alert-operation-1");
    expect(retry.body.id).toBe("alert-operation-1");
    expect(tx.emergencyAlert.create).toHaveBeenCalledOnce();
    expect(tx.emergencyAlert.create).toHaveBeenCalledWith({ data: expect.objectContaining({ operationId, createdById: "user-1" }) });
  });

  it("does not reveal an operation created by another user", async () => {
    vi.mocked(database.emergencyAlert.findUnique).mockResolvedValue({
      id: "alert-other", operationId: "965f92cf-7dc2-4c32-a6e1-64612944c8e3", createdById: "other-user",
      currentLocation: null,
    } as never);
    const response = await request(app).post("/api/alerts").set("Authorization", token("ADMIN")).send({
      operationId: "965f92cf-7dc2-4c32-a6e1-64612944c8e3", expeditionId: "exp-1", title: "SOS", message: "Retry", location: null,
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe("Operation ID has already been used");
    expect(database.$transaction).not.toHaveBeenCalled();
  });
});