# GitHub review bot

The workflow publishes prepared text and performs explicit GitHub actions as
the installed GitHub App. Codex prepares the text outside the workflow.

## Where a comment belongs

- **General summary** goes in the PR conversation. Summarize the outcome and
  list any remaining work. Use the default `publish` operation with just `pr`
  and `body`.
- **Review findings** go on the relevant changed lines. Explain the concrete
  problem, when it occurs, and what would fix it. Use the review body for the
  overall assessment and validation limits. Pass the reviewed commit SHA and
  findings in the `review` input.
- **Follow-up to feedback** goes in the existing review thread. Address the
  reviewer’s question or point to the commit that fixes it. Pass the first
  comment's numeric ID as `review_comment_id`.

## Inputs

Every run takes a pull request number in `pr`. Set `dry_run` to verify access
and the target without writing to GitHub. A dry run checks the review payload
and commit SHA. GitHub validates the diff anchors when the review is submitted.

| Operation | Other inputs |
| --- | --- |
| `publish` | `body`. Add `review_comment_id` for a thread reply or `review` for a complete review. |
| `reply_to_threads` | A JSON array in `replies` with one `{review_comment_id, body}` object per thread. |
| `edit_summary_comment` | The bot’s conversation comment ID in `target_id` and the new text in `body`. |
| `edit_review_summary` | The bot’s review ID in `target_id` and the new text in `body`. Inline findings stay attached to that review. |
| `resolve_thread` | The GraphQL review thread ID in `target_id`. Run after confirming the feedback has been addressed. |
| `react_to_review_comment` | The numeric ID of an inline comment in `target_id` and a reaction code in `reaction`. |
| `react_to_comment` | The numeric ID of a conversation comment in `target_id` and a reaction code in `reaction`. Requires the app’s Issues write permission. |
| `react_to_pr` | A reaction code in `reaction`. Requires the app’s Issues write permission. |

Reaction codes are `+1`, `-1`, `laugh`, `confused`, `heart`, `hooray`, `rocket`,
and `eyes`.

## Reply to several threads

Use `reply_to_threads` to answer several threads on one PR. In `replies.json`,
give each thread's first comment ID as a string and include the reply text.

```json
[
  {"review_comment_id": "4658197241", "body": "The fixed-signature call now uses a typed alias."},
  {"review_comment_id": "4658204315", "body": "The benchmark setup now lives in an HTML fixture."}
]
```

```sh
gh workflow run publish-pr-comment.yml --ref main \
  -f pr=1 -f operation=reply_to_threads -F replies=@replies.json
```

Add `-f dry_run=true` to check all thread IDs without posting. The run summary
shows the result and reply link for each thread. If publishing stops after an
API error, dispatch the same batch again. The bot reuses links to matching
replies it already posted and publishes the remaining ones.

## Publish a complete review

A complete review uses a JSON string for the `review` input. Use the current
PR head SHA and line numbers in the changed file. Use `RIGHT` for the new side
and `LEFT` for the old side. Add `start_line` and `start_side` for a range.

```json
{
  "commit_id": "0123456789abcdef0123456789abcdef01234567",
  "comments": [
    {
      "path": "src/example.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "Handle the empty response before parsing."
    }
  ]
}
```

This command checks access to an inline comment before adding a reaction.

```sh
gh workflow run publish-pr-comment.yml --ref main \
  -f pr=1 -f operation=react_to_review_comment \
  -f target_id=4658197241 -f reaction=eyes -f dry_run=true
```

## Credentials and forks

The publishing job runs on `main` for `notsecret808`. The `pr-comment-bot`
environment supplies the GitHub App client ID and private key. The token action
uses them to mint a short-lived installation token scoped to this repository.
The job uses that token to call GitHub through `gh` and revokes it at the end.
The workflow has no Codex or OpenAI API credentials.

A fork copies this workflow file. Its owner can adapt the actor condition and
set up an environment with a separate GitHub App installed on the fork.
GitHub keeps the original environment secrets in the original repository.
