import type { Database } from "@alook/shared"
import { resolveTargetForMember, type TargetResolution } from "./resolve-ref"
import { requireMessageSurfaceAccess } from "./permissions"
import { requireMessageBearingSurface } from "./channel-write-guard"
import { type MessageTarget } from "./message-handler"

/**
 * Door result. Unlike `permissions.Result` (whose status is 401|403|404 — the
 * existence/authz codes), the door also surfaces 400 (bad descriptor / malformed
 * ref) and the resolve layer's 400/404, so it carries an open numeric status.
 */
type DoorResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; hint?: unknown }

/**
 * The one-door target descriptor (Gener #744 / Aigneis #190).
 *
 * A message request addresses its target by EXACTLY ONE of:
 *  - `id`  — an already-resolved channelId (the web client holds it).
 *  - `ref` — a `/server/channel` etc. ref string (CLI/bot hold this).
 *
 * EXPLICIT xor, not a sniffed unified field: disambiguating a disc-shaped id
 * from a `/`-bearing ref by FORM is a coincidence that breaks the day id
 * encoding changes or ref syntax grows — the field name is the contract
 * (Aigneis #190 / Melly #187). `id` is the degenerate, already-resolved case of
 * `ref`; both land on the SAME trunk.
 *
 * `createDmIfMissing` / `createThreadIfMissing` live ONLY on the ref arm — an
 * `id` already names an existing row, so create-if-missing is meaningless there;
 * keeping them off the id arm makes resolve≠create a type-level invariant (the
 * id arm structurally cannot create).
 */
export type MessageTargetDescriptor =
  | { id: string; ref?: undefined }
  | {
      ref: string
      id?: undefined
      createDmIfMissing?: boolean
      createThreadIfMissing?: boolean
    }

export type DoorTarget = {
  /** The MessageTarget for createCommunityMessage (kind + ids). */
  target: MessageTarget
  /** True when the resolved surface is a DM — callers pass this to enrichMessages. */
  isDm: boolean
}

/**
 * Validate a raw body's target descriptor into the id-xor-ref union.
 * Rejects: neither field, both fields, wrong types, and create-if-missing on
 * the id arm (structurally forbidden — resolve≠create).
 */
export function parseTargetDescriptor(body: unknown): DoorResult<MessageTargetDescriptor> {
  const b = (body ?? {}) as Record<string, unknown>
  const hasId = typeof b.id === "string" && b.id.length > 0
  const hasRef = typeof b.ref === "string" && b.ref.length > 0

  if (hasId && hasRef) return err(400, "target must be exactly one of { id } or { ref }, not both")
  if (!hasId && !hasRef) return err(400, "target requires one of { id } or { ref }")

  if (hasId) {
    // create-if-missing is meaningless on an already-resolved id; reject rather
    // than silently ignore, so the id arm can never carry a create intent.
    if (b.createDmIfMissing || b.createThreadIfMissing) {
      return err(400, "create-if-missing is only valid with { ref }, not { id }")
    }
    return ok({ id: b.id as string })
  }
  return ok({
    ref: b.ref as string,
    createDmIfMissing: b.createDmIfMissing === true || undefined,
    createThreadIfMissing: b.createThreadIfMissing === true || undefined,
  })
}

function ok<T>(value: T): DoorResult<T> {
  return { ok: true, value }
}
function err(status: number, error: string): DoorResult<never> {
  return { ok: false, status, error }
}

/**
 * Resolve a target descriptor to a MessageTarget, applying the SINGLE
 * existence-mask output both arms share (Aigneis ④, the hard red line).
 *
 * ⚠ The id arm does NOT trust the caller-supplied id: a web-sent id is put
 * through the EXACT same `requireMessageSurfaceAccess` gate as a ref-resolved
 * id. "id is web-trusted, skip the mask" would be strictly worse than the old
 * two-door inconsistency — an id door with no mask. So both arms:
 *   1. arrive at a channelId (id: direct; ref: resolveTargetForMember),
 *   2. pass through requireMessageSurfaceAccess (one collapse point, one opaque
 *      404 body — a stranger constructing an unreachable id eats the same four
 *      cells: unknown→404 / non-member→403 / DM-non-participant→404 / blocked→403),
 *   3. build the MessageTarget from (surface + channel.type).
 *
 * The ONLY id/ref asymmetry is create-if-missing on the ref arm (Ingaborg #193):
 * a ref with a create flag may materialize its target (explicit verb); every
 * other side effect is byte-identical between the two forms.
 */
export async function resolveMessageTarget(
  db: Database,
  userId: string,
  descriptor: MessageTargetDescriptor,
  callerKind: "human" | "bot",
): Promise<DoorResult<DoorTarget>> {
  let channelId: string

  if (descriptor.ref !== undefined) {
    const resolved: TargetResolution = await resolveTargetForMember(db, userId, descriptor.ref, {
      createDmIfMissing: descriptor.createDmIfMissing,
      createThreadIfMissing: descriptor.createThreadIfMissing,
      callerKind,
    })
    if ("error" in resolved) {
      // Preserve the ambiguous-server-name candidate `hint` the CLI consumes
      // (resolveErrorResponse used to carry it) — dropping it would be a
      // silent CLI-facing regression.
      return { ok: false, status: resolved.error, error: resolved.message, hint: resolved.hint }
    }
    channelId = resolved.channelId
  } else {
    channelId = descriptor.id
  }

  // SINGLE mask output — both arms converge here (Aigneis ④).
  const access = await requireMessageSurfaceAccess(db, channelId, userId)
  if (!access.ok) return access

  if (access.value.surface === "dm") {
    // otherUserId consumed from the dispatch's DM peer — no re-query (Blondie #28).
    return ok({
      target: { kind: "dm", channelId, otherUserId: access.value.dm.otherUserId },
      isDm: true,
    })
  }

  const channel = access.value.channel
  const bearing = requireMessageBearingSurface(channel.type)
  if (!bearing.ok) return err(bearing.status, bearing.error)

  // A top-level `forum` channel gets its OWN kind (not the generic
  // "channel") so the send layer can dispatch "does this open a thread" off
  // the target's structural kind — the same channel.type this function
  // already resolved — instead of a body-field trigger.
  const target: MessageTarget = channel.parentChannelId
    ? {
        kind: "thread",
        channelId,
        parentChannelId: channel.parentChannelId,
        serverId: channel.serverId,
      }
    : channel.type === "forum"
      ? { kind: "forum", channelId, serverId: channel.serverId }
      : { kind: "channel", channelId, serverId: channel.serverId }

  return ok({ target, isDm: false })
}
