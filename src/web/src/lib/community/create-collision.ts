import { isUniqueConstraintError, type CreationTrait } from "@alook/shared"

/**
 * The single collision-handling strategy for CREATING a channel, dispatched
 * on the channel type's `creation` trait. "What a name/anchor collision
 * means" is hand-rolled in two shapes:
 *   - thread: catch the unique-conflict and re-SELECT the winner (get-or-create)
 *   - top-level text/forum: let the unique index 409 (reject-on-collision)
 * They collide on DIFFERENT keys (parent_message_id / server-name), so the
 * per-type CHANNEL-SHAPE construction stays with each caller — only the COLLISION
 * POLICY converges here, parameterized by callbacks the caller supplies. (DM is
 * NOT wired in this round: its collision is identity-collision on a user-pair, a
 * different key space — folding it would compress two collision-key axes into one
 * value, a false convergence. Its `creation: get-or-create` trait value stays in
 * the table describing the contract; its create entry `createOrGetDM` is untouched.)
 *
 * The caller provides:
 *   - `attempt()`: try to create the row; may throw a unique-constraint error on
 *     a concurrent collision.
 *   - `refetchWinner()`: (get-or-create only) re-select the existing row that won
 *     the race. Returns null if it somehow can't be found.
 *   - `onReject()`: (reject-on-collision only) the structured error to return when
 *     the create is refused.
 */

export type CollisionOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 409; error: string }

export async function createWithCollisionPolicy<T>(
  creation: CreationTrait,
  handlers: {
    attempt: () => Promise<T>
    refetchWinner?: () => Promise<T | null>
    onReject?: () => { status: 400 | 409; error: string }
  },
): Promise<CollisionOutcome<T>> {
  switch (creation) {
    case "get-or-create": {
      // Anchor identifies ONE unit (thread on its parent_message_id). A concurrent
      // create that lost the race → re-select the winner and return it. NEVER
      // create a second unit.
      try {
        return { ok: true, value: await handlers.attempt() }
      } catch (err) {
        if (isUniqueConstraintError(err) && handlers.refetchWinner) {
          const winner = await handlers.refetchWinner()
          if (winner !== null) return { ok: true, value: winner }
        }
        throw err
      }
    }
    case "reject-on-collision": {
      // A same-name create is refused (the unique index 409s). Surface the
      // caller's structured rejection rather than merging or bumping.
      try {
        return { ok: true, value: await handlers.attempt() }
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return { ok: false, ...(handlers.onReject?.() ?? { status: 409, error: "a channel with this name already exists" }) }
        }
        throw err
      }
    }
    default: {
      const _never: never = creation
      return _never
    }
  }
}
