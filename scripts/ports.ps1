function Get-SafeAppPort([int]$PreferredPort = 28460) {
    for ($p = $PreferredPort; $p -lt ($PreferredPort + 40); $p++) {
        $inUse = Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue
        if (-not $inUse) {
            return $p
        }
    }
    return $PreferredPort
}
