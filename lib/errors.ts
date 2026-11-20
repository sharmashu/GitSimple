import { NextResponse } from "next/server";

/** An error that maps directly to an HTTP response. */
export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export function errorResponse(e: unknown, fallback = "Something went wrong.") {
  if (e instanceof HttpError) {
    const headers: Record<string, string> = {};
    if (e.extra.retryAfter) headers["Retry-After"] = String(e.extra.retryAfter);
    return NextResponse.json({ error: e.message, ...e.extra }, { status: e.status, headers });
  }
  console.error(e);
  const msg = (e as any)?.message || fallback;
  return NextResponse.json({ error: msg }, { status: 502 });
}
