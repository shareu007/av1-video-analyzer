function sortForJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortForJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortForJson(value[key])]),
    );
  }
  return value;
}

export function stringifyCanonical(value, { pretty = false } = {}) {
  return `${JSON.stringify(sortForJson(value), null, pretty ? 2 : 0)}\n`;
}

export function stringifyReport(report, { pretty = true } = {}) {
  return stringifyCanonical(report, { pretty });
}
