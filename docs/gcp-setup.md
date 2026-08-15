# Google Cloud setup

TidyMap needs one GCP project with two APIs enabled and an OAuth client.

## 1. Create the project

1. Go to https://console.cloud.google.com/projectcreate
2. Name it `tidymap`. Note the project ID.

## 2. Enable billing

Places API (New) will not serve requests without a billing account attached.
Console → Billing → Link a billing account.

Phase 1 makes at most 20 Places calls per extraction. Text Search (New) bills
roughly $32 per 1,000 requests, so a run costs well under a dollar.

## 3. Enable the APIs

Console → APIs & Services → Enable APIs and Services. Enable both:

- **Data Portability API**
- **Places API (New)** — this is a separate product from the legacy "Places API"

## 4. Configure the OAuth consent screen

1. APIs & Services → OAuth consent screen
2. User type: **External**
3. Publishing status: leave as **Testing**
4. Under **Test users**, add your own Google account

> Testing mode allows up to 100 test users and needs no verification review.
> `dataportability.*` are restricted scopes — publishing to production requires
> Google's app verification, which takes weeks. Phase 1 stays in Testing.

## 5. Add the scopes

On the consent screen, add:

- `https://www.googleapis.com/auth/dataportability.saved.collections`
- `https://www.googleapis.com/auth/dataportability.maps.starred_places`
- `openid`
- `email`

## 6. Create the OAuth client

1. APIs & Services → Credentials → Create Credentials → OAuth client ID
2. Application type: **Web application**
3. Authorized redirect URI: `http://localhost:3000/auth/google/callback`
4. Copy the client ID and client secret

## 7. Create the Places API key

1. Credentials → Create Credentials → API key
2. Restrict it to the **Places API (New)**

## 8. Fill in `.env`

```bash
cp .env.example .env
```

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_PLACES_API_KEY`.

Note that `GOOGLE_PLACES_API_KEY` is required even when running in fixture
mode (`PORTABILITY_SOURCE=fixture` — see the README): fixture mode replaces
the Data Portability export with a committed sample, but every item in it
still goes through a real Places API enrichment call. Only a live run
(`PORTABILITY_SOURCE=live`) needs the OAuth client ID and secret.
