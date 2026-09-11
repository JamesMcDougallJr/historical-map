import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";

/**
 * HTTP Basic auth for the queue dashboard.
 *
 * Bull Board exposes every job payload and a Retry/Remove button on each one.
 * The pipeline this is modelled on mounted it unauthenticated, which was fine
 * for a take-home on localhost and is not fine anywhere reachable.
 *
 * **Fails closed**: with no password configured the dashboard returns 503
 * rather than mounting openly, so a missing environment variable cannot
 * silently publish it.
 */
export function basicAuth(user: string, password: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!password) {
      res.status(503).send(
        "Queue dashboard disabled: set BULL_BOARD_PASSWORD to enable it.",
      );
      return;
    }

    const header = req.headers.authorization ?? "";
    const [scheme, encoded] = header.split(" ");

    if (scheme === "Basic" && encoded) {
      const [givenUser, givenPassword] = Buffer.from(encoded, "base64")
        .toString()
        .split(":");
      if (
        safeEqual(givenUser ?? "", user) &&
        safeEqual(givenPassword ?? "", password)
      ) {
        next();
        return;
      }
    }

    res.setHeader("WWW-Authenticate", 'Basic realm="ingest queues"');
    res.status(401).send("Authentication required");
  };
}

/** Constant-time compare, length-padded so it cannot leak length by timing. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still do a comparison so the timing does not depend on length.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
