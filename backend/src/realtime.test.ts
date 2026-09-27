import { createServer } from "node:http";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signAuthToken } from "./auth/jwt.js";
import type { ClientToServerEvents, ServerToClientEvents } from "./realtime.js";
import {
  broadcastAlertNew,
  broadcastAssetStatusChange,
  broadcastCargoUpdate,
  broadcastLocationUpdated,
  broadcastPersonnelLocationUpdate,
  broadcastShipmentMilestoneAdded,
  createRealtimeServer,
  expeditionRoom,
} from "./realtime.js";

const findExpedition = vi.hoisted(() => vi.fn());
vi.mock("./db/prisma.js", () => ({ prisma: { expedition: { findUnique: findExpedition } } }));

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;
type TestServer = ReturnType<typeof createServer>;

describe("realtime server", () => {
  const servers: TestServer[] = [];
  const clients: TestClient[] = [];

  beforeEach(() => {
    process.env.JWT_SECRET = "realtime-test-secret";
    vi.mocked(findExpedition).mockReset().mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id }));
  });

  afterEach(async () => {
    clients.splice(0).forEach((client) => client.disconnect());
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  async function listeningServer() {
    const server = createServer();
    const realtime = createRealtimeServer(server);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server did not bind");
    return { realtime, url: `http://localhost:${address.port}` };
  }

  async function clientAt(url: string, token?: string) {
    const client = connect(url, { autoConnect: false, auth: token ? { token } : {} }) as TestClient;
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", () => resolve());
      client.once("connect_error", reject);
      client.connect();
    });
    return client;
  }

  async function joinExpedition(client: TestClient, id: string) {
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      client.emit("expedition:join", { expeditionId: id }, (result) => resolve(result));
    });
  }

  it("authenticates sockets and does not auto-join any expedition", async () => {
    const { realtime, url } = await listeningServer();
    const client = await clientAt(url, signAuthToken({ sub: "u1", role: "ADMIN" }));
    const serverSocket = realtime.sockets.sockets.get(client.id!);

    expect(serverSocket?.data.user).toMatchObject({ id: "u1", role: "ADMIN" });
    expect(serverSocket?.data.user.permissions).toContain("locations.read");
    expect([...serverSocket?.rooms ?? []].some((room) => room.startsWith("expedition:"))).toBe(false);
  });

  it("rejects unauthenticated, invalid, and expired tokens", async () => {
    const { url } = await listeningServer();
    const unauthenticated = connect(url, { autoConnect: false });
    clients.push(unauthenticated as TestClient);
    await expect(new Promise<void>((resolve, reject) => {
      unauthenticated.once("connect", () => resolve());
      unauthenticated.once("connect_error", reject);
      unauthenticated.connect();
    })).rejects.toThrow("Authentication required");

    const invalid = connect(url, { autoConnect: false, auth: { token: "invalid" } });
    clients.push(invalid as TestClient);
    await expect(new Promise<void>((resolve, reject) => {
      invalid.once("connect", () => resolve());
      invalid.once("connect_error", reject);
      invalid.connect();
    })).rejects.toThrow("Invalid or expired token");

    const expiredToken = jwt.sign({ sub: "expired", role: "ADMIN" }, process.env.JWT_SECRET!, { expiresIn: -1 });
    const expired = connect(url, { autoConnect: false, auth: { token: expiredToken } });
    clients.push(expired as TestClient);
    await expect(new Promise<void>((resolve, reject) => {
      expired.once("connect", () => resolve());
      expired.once("connect_error", reject);
      expired.connect();
    })).rejects.toThrow("Invalid or expired token");
  });

  it("requires a real, authorized expedition before joining its rooms", async () => {
    const { realtime, url } = await listeningServer();
    const client = await clientAt(url, signAuthToken({ sub: "u1", role: "FIELD_PERSONNEL" }));
    const joined = await joinExpedition(client, "exp-1");
    expect(joined).toEqual({ ok: true });
    expect(realtime.sockets.sockets.get(client.id!)?.rooms.has(expeditionRoom("exp-1"))).toBe(true);

    vi.mocked(findExpedition).mockResolvedValueOnce(null);
    const missing = await joinExpedition(client, "missing-expedition");
    expect(missing).toEqual({ ok: false, error: "Expedition not found or inaccessible" });
    expect(realtime.sockets.sockets.get(client.id!)?.rooms.has(expeditionRoom("missing-expedition"))).toBe(false);
  });

  it("reconnects without automatic expedition access or duplicate event listeners", async () => {
    const { realtime, url } = await listeningServer();
    const client = await clientAt(url, signAuthToken({ sub: "admin", role: "ADMIN" }));
    expect(await joinExpedition(client, "exp-1")).toEqual({ ok: true });
    let eventCount = 0;
    client.on("cargo.updated", () => { eventCount += 1; });

    client.disconnect();
    const reconnected = new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.connect();
    await reconnected;
    expect(realtime.sockets.sockets.get(client.id!)?.rooms.has(expeditionRoom("exp-1"))).toBe(false);
    expect(await joinExpedition(client, "exp-1")).toEqual({ ok: true });
    broadcastCargoUpdate({ id: "cargo-1", expeditionId: "exp-1", location: "-77,166", status: "IN_TRANSIT", updatedAt: new Date() });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(eventCount).toBe(1);
  });

  it("scopes cargo events to joined expedition rooms and retains both event names", async () => {
    const { realtime, url } = await listeningServer();
    const authorized = await clientAt(url, signAuthToken({ sub: "admin", role: "ADMIN" }));
    const notJoined = await clientAt(url, signAuthToken({ sub: "logistics", role: "LOGISTICS_OFFICER" }));
    expect(await joinExpedition(authorized, "exp-1")).toEqual({ ok: true });
    expect(realtime.sockets.sockets.get(authorized.id!)?.rooms.has("expedition:exp-1:role:ADMIN")).toBe(true);
    const received: string[] = [];
    const receivedOutsideRoom: string[] = [];
    authorized.onAny((event) => received.push(event));
    notJoined.onAny((event) => receivedOutsideRoom.push(event));
    broadcastCargoUpdate({ id: "cargo-1", expeditionId: "exp-1", location: "-77.85,166.67", status: "IN_TRANSIT", updatedAt: new Date() });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toEqual(expect.arrayContaining(["cargo.updated", "cargo:update"]));
    expect(receivedOutsideRoom).not.toEqual(expect.arrayContaining(["cargo.updated", "cargo:update"]));
  });

  it("redacts location payloads for joined roles without locations.read", async () => {
    const { url } = await listeningServer();
    const client = await clientAt(url, signAuthToken({ sub: "field", role: "FIELD_PERSONNEL" }));
    expect(await joinExpedition(client, "exp-1")).toEqual({ ok: true });
    const cargoEvent = new Promise<{ location: string | null; currentLocation?: unknown }>((resolve) => client.once("cargo.updated", resolve));
    const locationListener = vi.fn();
    client.on("location.updated", locationListener);
    const point = {
      id: "loc-1", latitude: -77.85, longitude: 166.67, observedAt: new Date(), accuracyMeters: null,
      altitudeMeters: null, source: "GPS", eventId: "event-1", expeditionId: "exp-1", createdAt: new Date(), updatedAt: new Date(),
    };
    broadcastCargoUpdate({ id: "cargo-1", expeditionId: "exp-1", location: "-77.85,166.67", currentLocation: point, status: "IN_TRANSIT", updatedAt: new Date() });
    broadcastLocationUpdated({ entityType: "personnel", entityId: "person-1", expeditionId: "exp-1", location: point });

    const cargo = await cargoEvent;
    expect(cargo.location).toBeNull();
    expect(cargo.currentLocation).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(locationListener).not.toHaveBeenCalled();
  });

  it("delivers location.updated only to joined roles with locations.read", async () => {
    const { url } = await listeningServer();
    const admin = await clientAt(url, signAuthToken({ sub: "admin", role: "ADMIN" }));
    const field = await clientAt(url, signAuthToken({ sub: "field", role: "FIELD_PERSONNEL" }));
    expect(await joinExpedition(admin, "exp-1")).toEqual({ ok: true });
    expect(await joinExpedition(field, "exp-1")).toEqual({ ok: true });
    const authorizedEvents: Array<{ entityId: string; location: { latitude: number } }> = [];
    const fieldListener = vi.fn();
    admin.on("location.updated", (event) => authorizedEvents.push(event));
    field.on("location.updated", fieldListener);
    const location = {
      id: "loc-1", latitude: -77.85, longitude: 166.67, observedAt: new Date(), accuracyMeters: null,
      altitudeMeters: null, source: "GPS", eventId: "event-1", expeditionId: "exp-1", createdAt: new Date(), updatedAt: new Date(),
    };
    broadcastLocationUpdated({ entityType: "personnel", entityId: "person-1", expeditionId: "exp-1", location });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(authorizedEvents).toHaveLength(1);
    expect(authorizedEvents[0]).toMatchObject({ entityId: "person-1", location: { latitude: -77.85 } });
    expect(fieldListener).not.toHaveBeenCalled();
  });

  it("scopes personnel location, asset status, and shipment milestone events by permission and expedition room", async () => {
    const { url } = await listeningServer();
    const admin = await clientAt(url, signAuthToken({ sub: "admin", role: "ADMIN" }));
    const field = await clientAt(url, signAuthToken({ sub: "field", role: "FIELD_PERSONNEL" }));
    const outsideRoom = await clientAt(url, signAuthToken({ sub: "other", role: "ADMIN" }));
    expect(await joinExpedition(admin, "exp-1")).toEqual({ ok: true });
    expect(await joinExpedition(field, "exp-1")).toEqual({ ok: true });

    const location = {
      id: "loc-personnel", latitude: -77.85, longitude: 166.67, observedAt: new Date(), accuracyMeters: null,
      altitudeMeters: null, source: "GPS", eventId: "event-personnel", expeditionId: "exp-1", createdAt: new Date(), updatedAt: new Date(),
    };
    const personnelEvent = new Promise<{ personnelId: string; location: { latitude: number } }>((resolve) => admin.once("personnel:location_update", resolve));
    const fieldPersonnelListener = vi.fn();
    const adminAssetEvent = new Promise<{ assetId: string; status: string }>((resolve) => admin.once("asset:status_change", resolve));
    const fieldAssetEvent = new Promise<{ assetId: string; status: string }>((resolve) => field.once("asset:status_change", resolve));
    const adminMilestoneEvent = new Promise<{ shipmentId: string; milestone: { id: string; type: string; occurredAt: Date } }>((resolve) => admin.once("shipment:milestone_added", resolve));
    const fieldMilestoneEvent = new Promise<{ shipmentId: string; milestone: { id: string; type: string; occurredAt: Date } }>((resolve) => field.once("shipment:milestone_added", resolve));
    const outsideRoomListener = vi.fn();
    field.on("personnel:location_update", fieldPersonnelListener);
    outsideRoom.onAny(outsideRoomListener);

    broadcastPersonnelLocationUpdate({ personnelId: "person-1", expeditionId: "exp-1", location });
    broadcastAssetStatusChange({ assetId: "asset-1", expeditionId: "exp-1", status: "DEPLOYED", updatedAt: new Date(), currentLocation: location } as never);
    broadcastShipmentMilestoneAdded({
      shipmentId: "shipment-1",
      expeditionId: "exp-1",
      milestone: { id: "milestone-1", type: "ARRIVED", occurredAt: new Date(), latitude: -77.85, longitude: 166.67 } as never,
    });

    expect(await personnelEvent).toMatchObject({ personnelId: "person-1", location: { latitude: -77.85 } });
    expect(await adminAssetEvent).toMatchObject({ assetId: "asset-1", status: "DEPLOYED" });
    expect(await fieldAssetEvent).toMatchObject({ assetId: "asset-1", status: "DEPLOYED" });
    const adminMilestone = await adminMilestoneEvent;
    const fieldMilestone = await fieldMilestoneEvent;
    expect(adminMilestone).toMatchObject({ shipmentId: "shipment-1", milestone: { id: "milestone-1", type: "ARRIVED" } });
    expect(fieldMilestone).toMatchObject({ shipmentId: "shipment-1", milestone: { id: "milestone-1", type: "ARRIVED" } });
    expect(adminMilestone.milestone).not.toHaveProperty("latitude");
    expect(fieldMilestone.milestone).not.toHaveProperty("longitude");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fieldPersonnelListener).not.toHaveBeenCalled();
    expect(outsideRoomListener).not.toHaveBeenCalled();
  });

  it("preserves emergency role notifications and scopes the typed event to joined rooms", async () => {
    const { url } = await listeningServer();
    const admin = await clientAt(url, signAuthToken({ sub: "admin", role: "ADMIN" }));
    const field = await clientAt(url, signAuthToken({ sub: "field", role: "FIELD_PERSONNEL" }));
    expect(await joinExpedition(admin, "exp-1")).toEqual({ ok: true });
    expect(await joinExpedition(field, "exp-1")).toEqual({ ok: true });
    let legacyPayload: Record<string, unknown> | undefined;
    const legacyEvent = new Promise<string>((resolve) => admin.once("alert:new", (alert) => { legacyPayload = alert as unknown as Record<string, unknown>; resolve(alert.id); }));
    const scopedEvent = new Promise<{ id: string; expeditionId: string }>((resolve) => admin.once("emergency.created", resolve));
    const fieldLegacy = vi.fn();
    const fieldScoped = vi.fn();
    field.on("alert:new", fieldLegacy);
    field.on("emergency.created", fieldScoped);
    broadcastAlertNew({
      id: "alert-1", expeditionId: "exp-1", title: "SOS", message: "Help", severity: "CRITICAL", status: "OPEN",
      location: "-77,166", createdAt: new Date(), resolvedAt: null, currentLocation: { latitude: -77, longitude: 166 },
    } as never);

    expect(await legacyEvent).toBe("alert-1");
    expect(legacyPayload).not.toHaveProperty("currentLocation");
    expect(await scopedEvent).toMatchObject({ id: "alert-1", expeditionId: "exp-1" });
    expect(fieldLegacy).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fieldScoped).toHaveBeenCalledOnce();
    expect(fieldScoped.mock.calls[0][0]).not.toHaveProperty("location");
    expect(fieldScoped.mock.calls[0][0]).not.toHaveProperty("currentLocation");
  });
});