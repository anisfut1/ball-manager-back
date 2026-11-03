/**
 * Vrai uniquement sur le déploiement de production Vercel (`VERCEL_ENV`
 * vaut « production »). Les previews et le développement local ne le sont
 * pas ; `NODE_ENV` n'est pas utilisé, il vaut « production » aussi en preview.
 * Seul endroit du dépôt qui lit cette variable.
 */
export function isProductionDeployment(): boolean {
  return process.env.VERCEL_ENV === "production";
}
