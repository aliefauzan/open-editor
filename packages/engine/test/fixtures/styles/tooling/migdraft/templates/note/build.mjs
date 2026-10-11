// Untrusted test hook: must never run, not even its migrate export (HOOK_UNTRUSTED).
throw new Error('untrusted hook ran');
