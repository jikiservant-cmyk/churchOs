import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function normalizeUgPhone(input: string) {
  // Strip all non-numeric characters except the leading '+'
  let raw = (input ?? "").trim();
  if (!raw) return "";

  // Remove everything except digits and '+'
  const cleaned = raw.replace(/[^\d+]/g, "");

  if (cleaned.startsWith("+256")) return cleaned;
  
  if (cleaned.startsWith("0")) {
    return `+256${cleaned.slice(1)}`;
  }

  // Handle cases where user types 772... or 256772... without leading 0 or +
  if (cleaned.length === 9 && !cleaned.startsWith("+")) {
    return `+256${cleaned}`;
  }
  
  if (cleaned.startsWith("256") && cleaned.length === 12) {
    return `+${cleaned}`;
  }

  return cleaned;
}
