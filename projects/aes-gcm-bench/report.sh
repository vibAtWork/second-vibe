#!/usr/bin/env bash
# Pretty-print a results CSV from run.sh as MB/s tables (one per keysize/op).
# If the CSV holds several rounds (--repeat), the best value per cell is shown.
set -euo pipefail
CSV="${1:?usage: report.sh results/aes-gcm-*.csv}"
awk -F, '
NR==1 { next }
{
  key=$3 SUBSEP $2; if (!(key in seenk)) { seenk[key]=1; keys[++nk]=key }
  if (!($1 in seeni)) { seeni[$1]=1; impls[++ni]=$1 }
  if (!($4 in seens)) { seens[$4]=1; sizes[++ns]=$4 }
  k4=$3 SUBSEP $2 SUBSEP $1 SUBSEP $4; if (!(k4 in v) || $7+0 > v[k4]+0) v[k4]=$7  # best of repeats
}
function hs(s) { return s>=1048576 ? s/1048576 "MiB" : s>=1024 ? s/1024 "KiB" : s "B" }
END {
  # sort sizes numerically
  for (i=1;i<=ns;i++) for (j=i+1;j<=ns;j++) if (sizes[j]+0 < sizes[i]+0) { t=sizes[i]; sizes[i]=sizes[j]; sizes[j]=t }
  for (q=1;q<=nk;q++) {
    split(keys[q], kk, SUBSEP)
    printf "AES-%s-GCM %s  (MB/s, higher is better)\n", kk[1], kk[2]=="enc" ? "encrypt" : "decrypt"
    printf "%-22s", "impl \\ msg size"; for (s=1;s<=ns;s++) printf "%10s", hs(sizes[s]); printf "\n"
    for (i=1;i<=ni;i++) {
      printf "%-22s", impls[i]
      for (s=1;s<=ns;s++) { x=v[kk[1],kk[2],impls[i],sizes[s]]; printf "%10s", x=="" ? "-" : sprintf("%.0f", x) }
      printf "\n"
    }
    ja=""; for (i=1;i<=ni;i++) if (impls[i] ~ /^java-/) ja=impls[i]
    if (ja!="" && ("openssl-evp" in seeni)) {
      printf "%-22s", "java/openssl-evp"
      for (s=1;s<=ns;s++) { a=v[kk[1],kk[2],ja,sizes[s]]; b=v[kk[1],kk[2],"openssl-evp",sizes[s]]
        printf "%10s", (a=="" || b=="" || b==0) ? "-" : sprintf("%.2fx", a/b) }
      printf "\n"
    }
    printf "\n"
  }
}' "$CSV"
