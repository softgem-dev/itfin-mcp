export interface TokenClaims {
  Email?: string;
  iat?: number;
  exp: number;
}

/** Decodes the payload of an ITFin token without verifying it. */
export function decodeToken(token: string): TokenClaims {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Malformed ITFin token");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenClaims;
  if (typeof claims.exp !== "number") throw new Error("ITFin token has no exp claim");
  return claims;
}
