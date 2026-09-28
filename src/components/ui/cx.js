/** Joins truthy class-name parts with single spaces. */
export const cx = (...parts) => parts.filter(Boolean).join(" ");
