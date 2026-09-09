type GitHubFetch = typeof fetch;

interface Pull {
  number: number;
  title: string;
  body: string | null;
  user: { login: string };
  state: string;
  merged_at?: string | null;
  draft: boolean;
  additions: number;
  deletions: number;
  changed_files: number;
  base: { ref: string };
  head: { ref: string; repo: { full_name: string } | null };
}

interface PullMetadata {
  number: number;
  title: string;
  body: string | null;
  author: { login: string };
  state: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: { path: string }[];
  baseRefName: string;
  headRefName: string;
}

function apiHeaders(token: string, accept = 'application/vnd.github+json'): Record<string, string> {
  return {
    accept,
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
  };
}

async function request(
  fetcher: GitHubFetch,
  url: string,
  token: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(apiHeaders(token));
  new Headers(init.headers).forEach((value, key) => {
    headers.set(key, value);
  });
  const response = await fetcher(url, {
    ...init,
    headers,
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${init.method ?? 'GET'} ${url} failed: ${response.status}`);
  }
  return response;
}

export async function fetchPullMetadata(
  fetcher: GitHubFetch,
  apiUrl: string,
  repository: string,
  token: string,
  pullNumber: number
): Promise<PullMetadata> {
  const root = `${apiUrl}/repos/${repository}`;
  const pull = (await (
    await request(fetcher, `${root}/pulls/${pullNumber}`, token)
  ).json()) as Pull;
  const files: { filename: string }[] = [];
  for (let page = 1; ; page += 1) {
    const batch = (await (
      await request(fetcher, `${root}/pulls/${pullNumber}/files?per_page=100&page=${page}`, token)
    ).json()) as { filename: string }[];
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body,
    author: { login: pull.user.login },
    state: pull.state.toUpperCase(),
    isDraft: pull.draft,
    additions: pull.additions,
    deletions: pull.deletions,
    changedFiles: pull.changed_files,
    files: files.map(({ filename }) => ({ path: filename })),
    baseRefName: pull.base.ref,
    headRefName: pull.head.ref,
  };
}

export async function fetchPullDiff(
  fetcher: GitHubFetch,
  apiUrl: string,
  repository: string,
  token: string,
  pullNumber: number
): Promise<string> {
  return request(fetcher, `${apiUrl}/repos/${repository}/pulls/${pullNumber}`, token, {
    headers: apiHeaders(token, 'application/vnd.github.v3.diff'),
  }).then(response => response.text());
}

export async function submitReview(
  fetcher: GitHubFetch,
  apiUrl: string,
  repository: string,
  token: string,
  pullNumber: number,
  event: 'APPROVE' | 'REQUEST_CHANGES',
  body: string
): Promise<void> {
  await request(fetcher, `${apiUrl}/repos/${repository}/pulls/${pullNumber}/reviews`, token, {
    method: 'POST',
    body: JSON.stringify({ event, body }),
  });
}

export async function squashMergeAndDeleteHead(
  fetcher: GitHubFetch,
  apiUrl: string,
  repository: string,
  token: string,
  pullNumber: number,
  commitTitle: string
): Promise<void> {
  const root = `${apiUrl}/repos/${repository}`;
  const pull = (await (
    await request(fetcher, `${root}/pulls/${pullNumber}`, token)
  ).json()) as Pull;
  const merge = (await (
    await request(fetcher, `${root}/pulls/${pullNumber}/merge`, token, {
      method: 'PUT',
      body: JSON.stringify({ merge_method: 'squash', commit_title: commitTitle }),
    })
  ).json()) as { merged?: boolean; message?: string };
  if (!merge.merged)
    throw new Error(`GitHub did not merge pull request: ${merge.message ?? 'unknown reason'}`);
  if (pull.head.repo?.full_name === repository) {
    await request(
      fetcher,
      `${root}/git/refs/heads/${pull.head.ref.split('/').map(encodeURIComponent).join('/')}`,
      token,
      { method: 'DELETE' }
    );
  }
}

export async function closePull(
  fetcher: GitHubFetch,
  apiUrl: string,
  repository: string,
  token: string,
  pullNumber: number,
  comment: string
): Promise<void> {
  const root = `${apiUrl}/repos/${repository}`;
  const pull = (await (
    await request(fetcher, `${root}/pulls/${pullNumber}`, token)
  ).json()) as Pull;
  if (pull.merged_at) throw new Error('cannot close a merged pull request');
  if (pull.state === 'closed') return;
  await request(fetcher, `${root}/issues/${pullNumber}/comments`, token, {
    method: 'POST',
    body: JSON.stringify({ body: comment }),
  });
  await request(fetcher, `${root}/pulls/${pullNumber}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed' }),
  });
}

async function main(): Promise<void> {
  const [command, numberText, ...args] = process.argv.slice(2);
  const pullNumber = Number(numberText);
  const token = process.env.GITHUB_TOKEN ?? '';
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  if (!command || !Number.isInteger(pullNumber) || pullNumber <= 0 || !token || !repository) {
    throw new Error(
      'command, positive PR number, GITHUB_TOKEN, and GITHUB_REPOSITORY are required'
    );
  }
  if (command === 'metadata') {
    console.log(
      JSON.stringify(await fetchPullMetadata(fetch, apiUrl, repository, token, pullNumber))
    );
  } else if (command === 'diff') {
    process.stdout.write(await fetchPullDiff(fetch, apiUrl, repository, token, pullNumber));
  } else if (command === 'review') {
    const [event, bodyPath] = args;
    if ((event !== 'APPROVE' && event !== 'REQUEST_CHANGES') || !bodyPath) {
      throw new Error('review requires APPROVE|REQUEST_CHANGES and a body file');
    }
    await submitReview(
      fetch,
      apiUrl,
      repository,
      token,
      pullNumber,
      event,
      await Bun.file(bodyPath).text()
    );
  } else if (command === 'merge') {
    await squashMergeAndDeleteHead(fetch, apiUrl, repository, token, pullNumber, args.join(' '));
  } else if (command === 'close') {
    await closePull(fetch, apiUrl, repository, token, pullNumber, args.join(' '));
  } else {
    throw new Error(`unknown command: ${command}`);
  }
}

if (import.meta.main) await main();
