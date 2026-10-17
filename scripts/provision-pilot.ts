import { readFileSync } from "node:fs";

const base = (process.env.HIVEATTIC_BASE_URL ?? "").replace(/\/$/, "");
const admin = process.env.HIVEATTIC_ADMIN_TOKEN ?? "";
const file = process.argv[2] ?? "examples/agents.example.json";
if (!base || !admin) {
  console.error("Set HIVEATTIC_BASE_URL and HIVEATTIC_ADMIN_TOKEN");
  process.exit(2);
}
const spec = JSON.parse(readFileSync(file, "utf8")) as {
  agents: { id: string; display_name?: string; kind?: "agent" | "external" | "human"; scopes: string[] }[];
};
for (const agent of spec.agents) {
  const response = await fetch(`${base}/v1/admin/tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: agent.id,
      display_name: agent.display_name ?? agent.id,
      kind: agent.kind ?? "agent",
      scopes: agent.scopes,
      label: agent.id,
    }),
  });
  const body = (await response.json()) as { data?: { token?: string }; error?: { code?: string } };
  if (!response.ok || !body.data?.token) {
    console.error(`Provision failed for ${agent.id} (${response.status} ${body.error?.code ?? ""})`);
    process.exit(1);
  }
  process.stdout.write(`${agent.id} ${body.data.token}\n`);
}
