const adjectives = [
  "Swift", "Calm", "Bold", "Bright", "Warm", "Keen", "Vast", "Crisp", "Agile", "Noble",
  "Vivid", "Lucid", "Brisk", "Deft", "Fleet", "Grand", "Lush", "Prime", "Sage", "True",
  "Clear", "Deep", "Fair", "Firm", "Glad", "Kind", "Pure", "Rich", "Safe", "Wise",
  "Fresh", "Sharp", "Steady", "Quick", "Gentle", "Silent", "Golden", "Radiant", "Serene", "Verdant",
];

const nouns = [
  "Falcon", "River", "Cedar", "Stone", "Ember", "Frost", "Bloom", "Ridge", "Crane", "Birch",
  "Coral", "Dawn", "Flint", "Grove", "Heron", "Lark", "Maple", "Opal", "Pearl", "Quartz",
  "Reef", "Sage", "Tide", "Vale", "Wren", "Aspen", "Brook", "Cliff", "Delta", "Eagle",
  "Fern", "Harbor", "Iris", "Jade", "Lotus", "Mesa", "Nova", "Orbit", "Pebble", "Summit",
];

export function generateSessionName(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj} ${noun}`;
}

export function generateUniqueSessionName(existingNames: Set<string>): string {
  for (let i = 0; i < 100; i++) {
    const name = generateSessionName();
    if (!existingNames.has(name)) return name;
  }
  return generateSessionName();
}

/**
 * Derive a short uppercase initials prefix from a user's name, e.g.
 * "Moritz Aschoff" → "MA", "Moritz" → "M". Used as the default session-name
 * prefix so sessions are tagged with who created them (e.g. "MA_InvoicePdf").
 */
export function initialsFromName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
