export function POST(): Response {
  return new Response('JavaScript is required to complete this secure sign-in flow.', {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    },
    status: 503,
  });
}
