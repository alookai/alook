import type { NextRequest } from "next/server"

export type AuthHandler<C> = (
  request: NextRequest,
  context: C & { params?: Record<string, string> },
) => Promise<Response>

/** Each successful resolution owns a fresh context for this request. */
export type AuthResolution<C> = Response | {
  context: C & { params?: Record<string, string> }
  finish?: (response: Response) => Response
}

export interface AuthPolicy<C> {
  preflight?: (request: NextRequest) => Response | null
  resolve: (request: NextRequest) => Promise<AuthResolution<C>>
  authorize?: (request: NextRequest, context: C & { params?: Record<string, string> }) => Response | null | Promise<Response | null>
  respond?: (request: NextRequest, response: Response) => Response | Promise<Response>
}

export function createAuth<C>(policy: AuthPolicy<C>) {
  return (handler: AuthHandler<C>) => async (
    request: NextRequest,
    route?: { params?: Promise<Record<string, string>> | Record<string, string> },
  ): Promise<Response> => {
    let response = policy.preflight?.(request) ?? null
    if (!response) {
      const params = route?.params instanceof Promise ? await route.params : route?.params
      const resolved = await policy.resolve(request)
      if (resolved instanceof Response) {
        response = resolved
      } else {
        const context = resolved.context
        context.params = params
        const result = (policy.authorize ? await policy.authorize(request, context) : null)
          ?? handler(request, context)
        if (!resolved.finish && !policy.respond) return result
        response = await result
        if (resolved.finish) response = resolved.finish(response)
      }
    }
    return policy.respond ? policy.respond(request, response) : response
  }
}
