import { z } from 'zod';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const conflict = (message: string) => new HttpError(409, message);

/** Parse with zod, turning failures into a 400 with a readable message. */
export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length ? `${issue.path.join('.')}: ` : '';
    throw new HttpError(400, `${where}${issue?.message ?? 'invalid request'}`);
  }
  return result.data;
}

/** Trimmed, 1–200 chars. Used for both category names and item titles. */
export const nameSchema = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .max(200, 'must be at most 200 characters');

export const idParams = z.object({ id: z.string().uuid('must be a valid id') });

/** Query-string boolean: "true"/"1" are true, anything else false. */
export const queryBool = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => v === true || v === 'true' || v === '1');

export const ITEM_STATUSES = ['active', 'paused', 'done'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export interface CategoryRow {
  id: string;
  name: string;
  sort_order: number;
  created_at: Date;
  archived_at: Date | null;
}

export interface ItemRow {
  id: string;
  category_id: string;
  title: string;
  status: ItemStatus;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

export const toCategory = (r: CategoryRow) => ({
  id: r.id,
  name: r.name,
  sortOrder: r.sort_order,
  createdAt: r.created_at,
  archivedAt: r.archived_at,
});

export const toItem = (r: ItemRow) => ({
  id: r.id,
  categoryId: r.category_id,
  title: r.title,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  archivedAt: r.archived_at,
});
