import {
  BatchRequestBody,
  BatchRequestResponse,
  BatchRequestResult,
} from "@/types/base/batch/batch";
import mutate from "@/Utils/request/mutate";
import { ApiRoute, HttpMethod, Type } from "@/Utils/request/types";
import { makeUrl } from "@/Utils/request/utils";
import {
  DefaultError,
  QueryClient,
  useMutation,
  UseMutationOptions,
} from "@tanstack/react-query";

export interface BatchRequestObject<T = unknown> {
  api: ApiRoute<unknown, unknown>;
  pathParams?: Record<string, string>;
  body: T;
  referenceId: string;
}

/**
 * Determines whether an individual batch sub-request succeeded.
 *
 * The batch endpoint echoes back every request's `reference_id` regardless of
 * whether that specific sub-request succeeded or failed, and carries the real
 * outcome in each result's `status_code`. Matching on `reference_id` alone is
 * therefore not enough to conclude a sub-request succeeded — the status code
 * must be inspected as well.
 */
export function isBatchResultSuccessful(result: BatchRequestResult): boolean {
  return result.status_code >= 200 && result.status_code < 300;
}

/**
 * Finds a batch result by `reference_id` only when that sub-request succeeded.
 * Returns `undefined` when the referenced request is absent or failed.
 */
export function findSuccessfulResult<T = unknown>(
  results: BatchRequestResult<T>[],
  referenceId: string,
): BatchRequestResult<T> | undefined {
  return results.find(
    (result) =>
      result.reference_id === referenceId && isBatchResultSuccessful(result),
  );
}

export function useBatchRequest<TError = DefaultError, TContext = unknown>(
  options: UseMutationOptions<
    BatchRequestResponse,
    TError,
    BatchRequestObject[],
    TContext
  >,
  queryClient?: QueryClient,
) {
  const mutation = useMutation(
    {
      mutationFn: (requests: BatchRequestObject[]) =>
        mutate({
          path: "/api/v1/batch_requests/",
          method: HttpMethod.POST,
          TRes: Type<BatchRequestResponse>(),
          TBody: Type<BatchRequestBody>(),
        })({
          requests: requests.map((request) => ({
            url: makeUrl(request.api.path, undefined, request.pathParams),
            method: request.api.method ?? HttpMethod.GET,
            reference_id: request.referenceId,
            body: request.body,
          })),
        }),
      ...options,
    },
    queryClient,
  );

  return {
    ...mutation,
  };
}
