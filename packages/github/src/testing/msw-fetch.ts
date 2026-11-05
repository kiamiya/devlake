import { getResponse, type RequestHandler } from 'msw';

/**
 * `fetch` qui sert les requêtes avec des handlers msw, sans aucune socket.
 * Une requête sans handler échoue, comme `onUnhandledRequest: 'error'`.
 */
export function mswFetch(handlers: () => RequestHandler[]): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const response = await getResponse(handlers(), request);
    if (!response) {
      throw new TypeError(`Aucun handler msw pour ${request.method} ${request.url}`);
    }
    // HttpResponse.error() simule une coupure réseau : fetch rejette alors une TypeError.
    if (response.type === 'error') throw new TypeError('fetch failed');
    return response;
  };
}
