// Garment parts the user can select in ColorStudio, and the text prompt sent to
// the segmentation backend for each. This is the single place to tweak prompts.

export type GarmentPart = {
  /** Stable id; sent to the backend as part_key and used to cache masks. */
  key: string;
  /** Shown on the chip. */
  label: string;
  /** Text prompt for the segmentation model. */
  prompt: string;
};

export const GARMENT_PARTS: GarmentPart[] = [
  { key: "kurta", label: "Kurta", prompt: "kurta" },
  { key: "kurti", label: "Kurti", prompt: "tunic top" },
  { key: "koti", label: "Koti / Nehru jacket", prompt: "nehru jacket" },
  { key: "shirt", label: "Shirt", prompt: "shirt" },
  { key: "pant", label: "Pant", prompt: "trousers" },
  { key: "suit", label: "Suit / Coat", prompt: "suit jacket" },
  { key: "sherwani", label: "Sherwani", prompt: "long coat" },
  { key: "lehenga", label: "Lehenga", prompt: "skirt" },
  { key: "blouse", label: "Blouse", prompt: "blouse" },
  { key: "dupatta", label: "Dupatta", prompt: "scarf" },
  { key: "saree", label: "Saree", prompt: "saree" }
];

// Checked in order, so the more specific names win: "kurti" before "kurta",
// "Kurta Koti Set" -> koti, "Single Breasted Suit" -> suit.
const NAME_RULES: { key: string; pattern: RegExp }[] = [
  { key: "sherwani", pattern: /sherwani|achkan/ },
  { key: "lehenga", pattern: /lehenga|lehnga|ghagra/ },
  { key: "blouse", pattern: /blouse|choli/ },
  { key: "dupatta", pattern: /dupatta/ },
  { key: "saree", pattern: /saree|sari\b/ },
  { key: "koti", pattern: /koti|nehru/ },
  { key: "suit", pattern: /suit|blazer|coat/ },
  { key: "kurti", pattern: /kurti/ },
  { key: "kurta", pattern: /kurta/ },
  { key: "shirt", pattern: /shirt/ },
  { key: "pant", pattern: /pant|trouser/ }
];

export function findGarmentPart(key: string | null | undefined): GarmentPart | null {
  if (!key) return null;
  return GARMENT_PARTS.find((part) => part.key === key) ?? null;
}

/** Best part to pre-select for a garment type name such as "Single Breasted Suit"; null if none fits. */
export function defaultPartForGarmentName(name: string | null | undefined): GarmentPart | null {
  const text = name?.trim().toLowerCase();
  if (!text) return null;
  for (const rule of NAME_RULES) {
    if (rule.pattern.test(text)) return findGarmentPart(rule.key);
  }
  return null;
}
