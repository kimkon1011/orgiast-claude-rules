# Normalize-UserId: convert any UserId format (SID, DOMAIN\user, bare user)
# to a canonical bare username for reliable comparison.
# Translation failure falls back to the original value.
function Normalize-UserId {
    param([string]$RawUserId)
    if ($RawUserId -match '^S-1-') {
        try {
            $sid = [System.Security.Principal.SecurityIdentifier]$RawUserId
            return ($sid.Translate([System.Security.Principal.NTAccount]).Value -replace '.*\\', '').ToLowerInvariant()
        } catch { return $RawUserId }
    }
    return ($RawUserId -replace '.*\\', '').ToLowerInvariant()
}