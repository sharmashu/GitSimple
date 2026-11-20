// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This is a Supabase Edge Function to process GitHub webhooks directly inside Supabase

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const openAiKey = Deno.env.get("OPENAI_API_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    }); ``
  }

  try {
    const payload = await req.json();
    const commits = payload.commits || [];
    const repository = payload.repository || {};
    const branch = payload.ref ? payload.ref.replace("refs/heads/", "") : "main";

    if (commits.length === 0) {
      return new Response(JSON.stringify({ status: "ignored", message: "No commits found" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Process commits in background execution using EdgeRuntime.waitUntil if available
    // @ts-ignore
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(processCommits(commits, repository, branch));
    } else {
      processCommits(commits, repository, branch);
    }

    return new Response(
      JSON.stringify({
        status: "accepted",
        message: `Processing ${commits.length} commits for ${repository.name || "repository"}`,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

async function processCommits(commits: any[], repo: any, branch: string) {
  for (const commit of commits) {
    console.log(`Processing commit ${commit.id} from ${commit.author?.name}`);
    // Extract summary and generate embeddings
  }
}
