import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/server";
import { describeAiConfig } from "@/lib/llm";

export const dynamic = "force-dynamic";

/** GET /api/health — used by Docker HEALTHCHECK and uptime monitors. Never returns secrets. */
export async function GET() {
  let database = "ok";
  try {
    const { error } = await createAdminClient().from("repositories").select("id", { head: true, count: "exact" }).limit(1);
    if (error) database = `error: ${error.message}`;
  } catch (e: any) {
    database = `error: ${e?.message || "unreachable"}`;
  }
  const ai = describeAiConfig();
  const ok = database === "ok" && ai.llm.configured && ai.embeddings.configured;
  return NextResponse.json(
    {
      ok,
      database,
      ...ai,
      githubServerToken: !!process.env.GITHUB_TOKEN,
      webhooks: !!(process.env.GITHUB_WEBHOOK_SECRET && process.env.WEBHOOK_PROXY_URL),
    },
    { status: ok ? 200 : 503 }
  );
}
