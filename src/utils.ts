// =============================================================================
// Utility Functions
// =============================================================================

export function milliunitsToUSD(milliunits: number): number {
  return milliunits / 1000;
}

export function usdToMilliunits(usd: number): number {
  return Math.round(usd * 1000);
}

export function formatUSD(milliunits: number): string {
  const usd = milliunitsToUSD(milliunits);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(usd);
}

export function parseDate(input: string): string {
  const lower = input.toLowerCase();
  const today = new Date();

  if (lower === "today") {
    return today.toISOString().split("T")[0];
  }
  if (lower === "yesterday") {
    today.setDate(today.getDate() - 1);
    return today.toISOString().split("T")[0];
  }
  if (lower === "tomorrow") {
    today.setDate(today.getDate() + 1);
    return today.toISOString().split("T")[0];
  }

  // Try to parse as date
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split("T")[0];
  }

  throw new Error(`Could not parse date: "${input}". Try formats like "today", "yesterday", "2024-01-15"`);
}
