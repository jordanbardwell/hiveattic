export function logEvent(fields: Record<string, string | number | boolean | null>): void {
  console.log(JSON.stringify({ service: "hiveattic", ...fields }));
}
