import os


class Settings:
    # --- Neon Postgres (replaces DynamoDB + RDS) ----------------------------
    # Use the POOLED connection string (the host containing "-pooler"). The
    # direct one runs out of connections as soon as both Render instances are
    # awake at the same time.
    DATABASE_URL: str = os.getenv("DATABASE_URL", "")

    # --- Cloudflare R2 (replaces S3) ---------------------------------------
    R2_ACCOUNT_ID: str = os.getenv("R2_ACCOUNT_ID", "")
    R2_ACCESS_KEY_ID: str = os.getenv("R2_ACCESS_KEY_ID", "")
    R2_SECRET_ACCESS_KEY: str = os.getenv("R2_SECRET_ACCESS_KEY", "")
    R2_BUCKET: str = os.getenv("R2_BUCKET", "smart-odour-raw")

    # --- Identity of this instance -----------------------------------------
    # Set to "primary" on the Singapore service and "standby" on Oregon.
    # The dashboard reads it back from /health so you can see which box
    # answered without opening dev tools.
    INSTANCE_ROLE: str = os.getenv("INSTANCE_ROLE", "primary")
    INSTANCE_REGION: str = os.getenv("INSTANCE_REGION", "singapore")

    # --- Campus geography ---------------------------------------------------
    CAMPUS_LAT: float = float(os.getenv("CAMPUS_LAT", "2.3129"))
    CAMPUS_LON: float = float(os.getenv("CAMPUS_LON", "102.3197"))

    ADMIN_TOKEN: str = os.getenv("ADMIN_TOKEN", "change-me")


settings = Settings()
