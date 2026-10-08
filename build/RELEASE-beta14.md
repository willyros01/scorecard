# 2.30.0-beta.14 — favourite courses

Asked for by Willy on 8 October 2026 ("a section on the golf course selection for my favourite or frequently used courses, in sync in the web and iOS app").

## Changes

- Every course list (Enter in both layouts, new game, edit game, History filter) starts with **My favourites**, then **Played most** (up to 3, counted from the rounds this account can see in the open group), then **All courses** A to Z. A course chosen is selected once only.
- Under the chosen course on Enter: **Add to my favourites** / **In my favourites — tap to remove**.
- Favourites are kept on the account at `users/{uid}/prefs/courses` (`favourites: [courseIds]`), written through the outbox (store and forward), cached on the device per account, loaded whenever a group opens. Same code on the website and in the iPhone app, so they always match.
- Account deletion removes them (the completion job clears `users/{uid}`). Any future version 1 clean-up under `users/{uid}` must KEEP `prefs` and `terms`.
- Guide (quick-start.html): new "Favourite courses" paragraph.

## Automated coverage

- E34: starred on the website, the same account in app mode sees it first in the course list; removed in the app, it is gone from the account.

## Deployment

No Firebase rule, index or data change (the existing users/{uid}/** rule covers it). The same beta.14 files go to TestFlight and the web.
