import { z } from "zod";

export const paginationSchema = {
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
};

export function limitOffset(query: {
  page: number;
  page_size: number;
}): [number, number] {
  return [query.page_size, (query.page - 1) * query.page_size];
}

/** Query-string parameters as an object; an empty value counts as absent. */
export function queryParams(request: Request): Record<string, string> {
  const params: Record<string, string> = {};
  new URL(request.url).searchParams.forEach((value, key) => {
    if (value !== "") params[key] = value;
  });
  return params;
}
