declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    VIDEO_JOBS_QUEUE: Queue;
    DLQ_QUEUE_NAME: string;
    RETENTION_DAYS: string;
    OPERATOR_IDS: string;
    TEST_MIGRATIONS: D1Migration[];
    /** Bound only by the E-3.2 development Worker configuration. */
    VIDEO_UPLOADS_R2?: R2Bucket;
    /** Must match the VIDEO_UPLOADS_R2 bucket_name in the development Wrangler configuration. */
    R2_BUCKET_NAME?: string;
    R2_ACCOUNT_ID?: string;
    R2_UPLOAD_ACCESS_KEY_ID?: string;
    R2_UPLOAD_SECRET_ACCESS_KEY?: string;
    /** Required for every development-only HTTP route; never configured in production. */
    DEV_TEST_SECRET?: string;
    /** Non-secret OAuth client identifier; the secret is stored only as a Worker Secret. */
    YOUTUBE_OAUTH_CLIENT_ID?: string;
    /** Worker Secret binding. Never place its value in Wrangler configuration. */
    YOUTUBE_OAUTH_CLIENT_SECRET?: string;
    /** Worker Secret binding used to encrypt dynamic OAuth credentials before D1 storage. */
    YOUTUBE_OAUTH_ENCRYPTION_KEY?: string;
    /** Approved public YouTube channel identifier. It must not be learned from OAuth results. */
    YOUTUBE_EXPECTED_CHANNEL_ID?: string;
    /** HTTPS callback URI protected by Cloudflare Access. */
    YOUTUBE_OAUTH_REDIRECT_URI?: string;
    /** Non-secret Cloudflare Access team domain, without scheme. */
    CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
    /** Non-secret audience tag of the dedicated Cloudflare Access application. */
    CLOUDFLARE_ACCESS_AUD?: string;
    /** Worker Secret containing the comma-separated allowlisted operator emails. */
    YOUTUBE_OAUTH_ALLOWED_EMAILS?: string;
    /** Temporary non-secret diagnostic switch. Only the exact value "true" exposes coarse 404 stages. */
    YOUTUBE_OAUTH_DIAGNOSTICS_ENABLED?: string;
  }
}

type Env = Cloudflare.Env;
