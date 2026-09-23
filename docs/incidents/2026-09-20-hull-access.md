# Hull source access failure, September 20–22, 2026

## Finding

Hull's source failure happens before agenda parsing. A fresh request on September
21 at 23:59:43 UTC returned HTTP 403, `server: cloudflare`,
`cf-mitigated: challenge`, and a `Just a moment...` HTML page. The page identified
its challenge as `managed`. The Ray ID was `a3ed067abfbf74e4-DFW`.

That request used townCivic's configured user agent, Accept and Accept-Language
headers from this development environment, which has an HTTP proxy. It is not
a measurement of the user's home network or proof that GitHub saw the same
Cloudflare rule. The new one-source Actions probe records that evidence from
the actual hosted runner.

Cloudflare documents
[`cf-mitigated: challenge`](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)
as its challenge-page signal. A status code alone cannot identify the rule or
feature that issued it. The site's operator can use the
[Ray ID and request time](https://developers.cloudflare.com/fundamentals/reference/cloudflare-ray-id/)
to investigate the matching security event.

## Timeline (UTC)

| Refresh run                                                                     | First Hull response | Result                                                    |
| ------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------- |
| [35470344424](https://github.com/derivagral/townCivic/actions/runs/35470344424) | Sep 19, 21:25:52    | Select Board 200, 51 items; all 20 Hull sources succeeded |
| [35510046218](https://github.com/derivagral/townCivic/actions/runs/35510046218) | Sep 20, 12:15:48    | First Hull request 403; all 20 failed                     |
| [35538756623](https://github.com/derivagral/townCivic/actions/runs/35538756623) | Sep 20, 21:28:25    | First Hull request 403; all 20 failed                     |
| [35608830055](https://github.com/derivagral/townCivic/actions/runs/35608830055) | Sep 21, 13:57:32    | First Hull request 403; all 20 failed                     |
| [35663239019](https://github.com/derivagral/townCivic/actions/runs/35663239019) | Sep 21, 22:33:56    | First Hull request 403; all 20 failed                     |

All these runs used main commit `34e16fc933c6b2426be7f3518e659c99ac740091`.
No code deployment separates the last success from the first failure.
The older logs contain HTTP status only; their precise Cloudflare reason cannot
be reconstructed from those logs.

## Did we trigger it?

The observed pattern does not support a burst **within the failed run**: the
first Hull request is denied, then the remaining sources fail at roughly
one-second intervals. The schedule has two runs a day and the fetcher does not
retry HTTP 403. Those later 19 requests did not cause the first denial.

The preceding successful run also used the same pacing: its 20 Hull listing
responses span about 21 seconds, with no new or revised records. This is evidence
against a newly introduced crawler burst, not proof that prior traffic could
not have contributed to a security decision. These counts cover listing
requests in the observed runs, not every client or all historic traffic.

Plausible explanations remain a changed security rule, bot/browser detection,
or an IP/network reputation decision affecting hosted traffic. A longer-lived
rate/reputation decision is still possible. There is no evidence of a specific
rule, an explicit ban of townCivic, or a simple retry delay that would resolve
it. We do not have Hull's Cloudflare Security Events or rule-change history.

## Updates in PR #22

- Detect the explicit Cloudflare challenge header before treating a response as
  success or retryable; retain status and a validated Ray ID in the error.
- Stop that request without reading/logging challenge bodies or cookies. HTML
  guards from the earlier PR commit still cover known pages lacking the header.
- Add `scripts/probe-hull.mjs` and a matching Actions check. One registered
  source, no retries or stored validators, no production credentials, no
  database or snapshot changes. Log and preserve the JSON report and fail the
  check when access or parsing fails.
- Test challenges with HTTP 200/202/403/503, ordinary denials, successful
  Cloudflare-served content, and conditional responses.

Publication gates remain intact. This diagnostic change does not restore Hull
access, reduce the scheduled run to one Hull request, or assert that a fresh
runner will be accepted.

## Next evidence and recovery

Run the one-source probe from the user's local environment and compare it with
the Actions report using the same crawler identity. Success locally but a
challenge in Actions would narrow this to a difference in network/request
classification; challenges in both would indicate broader scope.

If the denial persists, the useful handoff to Hull's website operator/CivicPlus
is the requested URL, UTC time, user agent, and Ray ID. Ask which security
feature/rule matched and whether an approved feed or narrowly scoped crawler
access is available. No request to the operator has been sent.

After the intended runner receives a real listing, rerun Refresh and verify
Hull ingestion, Status, snapshot publication, and Deploy. Do not use `force`,
disable the sources, or suppress errors as a substitute for resolving access.
