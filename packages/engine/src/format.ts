// Display helpers shared by clients. Ported from the prototype.

export function fm(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return '$' + (n / 1e3).toFixed(1) + 'K';
  if (a >= 100) return '$' + Math.round(n).toLocaleString('en-US');
  return '$' + n.toFixed(2);
}

export function fp(p: number): string {
  if (p >= 1) return p.toFixed(3);
  if (p < 1e-6) return p.toExponential(2);
  return p.toPrecision(3);
}
