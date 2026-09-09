import { describe, expect, test } from 'bun:test';
import {
  closePull,
  fetchPullMetadata,
  squashMergeAndDeleteHead,
  submitReview,
} from './marketplace-github';

const pull = (repository = 'kombiz/Archon') => ({
  number: 7,
  title: 'submission',
  body: null,
  user: { login: 'author' },
  state: 'open',
  draft: false,
  additions: 2,
  deletions: 1,
  changed_files: 101,
  base: { ref: 'dev' },
  head: { ref: 'feature/entry', repo: { full_name: repository } },
});

describe('marketplace GitHub REST adapter', () => {
  test('paginates files and preserves gh metadata shape', async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      const value = String(url);
      calls.push(value);
      if (!value.includes('/files?')) return Response.json(pull());
      const page = Number(new URL(value).searchParams.get('page'));
      return Response.json(
        page === 1
          ? Array.from({ length: 100 }, (_, index) => ({ filename: `file-${index}` }))
          : [{ filename: 'packages/docs-web/src/data/marketplace.ts' }]
      );
    }) as typeof fetch;
    const metadata = await fetchPullMetadata(
      fetcher,
      'https://api.test',
      'kombiz/Archon',
      'token',
      7
    );
    expect(metadata.files).toHaveLength(101);
    expect(metadata.author.login).toBe('author');
    expect(calls.filter(url => url.includes('/files?'))).toHaveLength(2);
  });

  test('posts the requested review event and body', async () => {
    let request: RequestInit | undefined;
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      request = init;
      return Response.json({});
    }) as typeof fetch;
    await submitReview(
      fetcher,
      'https://api.test',
      'kombiz/Archon',
      'token',
      7,
      'REQUEST_CHANGES',
      'fix it'
    );
    expect(JSON.parse(String(request?.body))).toEqual({ event: 'REQUEST_CHANGES', body: 'fix it' });
  });

  test('squash merges and deletes only a same-repository head', async () => {
    const methods: string[] = [];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      return Response.json(methods.length === 1 ? pull() : { merged: true });
    }) as typeof fetch;
    await squashMergeAndDeleteHead(
      fetcher,
      'https://api.test',
      'kombiz/Archon',
      'token',
      7,
      'feat: entry'
    );
    expect(methods).toEqual(['GET', 'PUT', 'DELETE']);
  });

  test('does not delete an external fork head', async () => {
    const methods: string[] = [];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      return Response.json(methods.length === 1 ? pull('contributor/Archon') : { merged: true });
    }) as typeof fetch;
    await squashMergeAndDeleteHead(
      fetcher,
      'https://api.test',
      'kombiz/Archon',
      'token',
      7,
      'feat: entry'
    );
    expect(methods).toEqual(['GET', 'PUT']);
  });

  test('comments before closing a rejected pull request', async () => {
    const calls: Array<[string, string]> = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init?.method ?? 'GET']);
      return Response.json({});
    }) as typeof fetch;
    await closePull(fetcher, 'https://api.test', 'kombiz/Archon', 'token', 7, 'closing');
    expect(calls.map(([, method]) => method)).toEqual(['POST', 'PATCH']);
  });
});
