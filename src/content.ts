import agentsMd from "../content/vault/AGENTS.md";
import readmeMd from "../content/vault/README.md";

export const AGENTS_MD = agentsMd.endsWith("\n") ? agentsMd : `${agentsMd}\n`;
export const README_MD = readmeMd.endsWith("\n") ? readmeMd : `${readmeMd}\n`;
