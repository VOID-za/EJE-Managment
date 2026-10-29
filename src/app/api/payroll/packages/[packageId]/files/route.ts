import { z } from 'zod';
import { loadFinancePackageFile } from '@/application/finance-packages';
import { downloadRoute, parseWith } from '@/server/api/handler';

/** One attachment of a package, exactly as stored and sent (PAY-08). The office only. */
export const GET = downloadRoute('payroll.package.file', async (context) => {
  const { name } = parseWith(z.object({ name: z.string().min(1).max(200) }).strict(), Object.fromEntries(context.request.nextUrl.searchParams));
  const file = await loadFinancePackageFile({ repos: context.repos, services: context.services, actor: context.actor.user }, context.params.packageId ?? '', name);
  return { fileName: file.fileName, contentType: 'application/pdf', body: file.bytes };
});
