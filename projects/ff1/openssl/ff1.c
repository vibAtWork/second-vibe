/*
 * NIST SP 800-38G FF1 on OpenSSL libcrypto.
 *
 * Structure follows BouncyCastle's SP80038G.encFF1/decFF1 with the same three
 * optimizations used by every port in this repository:
 *   1. CIPH_K(P) computed once per call; each round CBC-MACs only Q from it.
 *   2. Feistel halves stay BIGNUMs across rounds (NUM/STR once each way).
 *   3. radix^u and radix^v computed once per call.
 */
#include "ff1.h"

#include <stdlib.h>
#include <string.h>

#define BLOCK 16
#define MIN_DOMAIN 1000000ULL

int ff1_init(ff1_ctx *c, const uint8_t *key, size_t key_len, unsigned radix)
{
    const EVP_CIPHER *ciph;
    memset(c, 0, sizeof(*c));
    if (radix < 2 || radix > 65536)
        return FF1_ERR_RADIX;
    switch (key_len) {
    case 16: ciph = EVP_aes_128_ecb(); break;
    case 24: ciph = EVP_aes_192_ecb(); break;
    case 32: ciph = EVP_aes_256_ecb(); break;
    default: return FF1_ERR_KEY;
    }
    c->aes = EVP_CIPHER_CTX_new();
    c->bn = BN_CTX_new();
    if (!c->aes || !c->bn ||
        EVP_EncryptInit_ex(c->aes, ciph, NULL, key, NULL) != 1 ||
        EVP_CIPHER_CTX_set_padding(c->aes, 0) != 1) {
        ff1_free(c);
        return FF1_ERR_INTERNAL;
    }
    c->radix = radix;
    c->group_len = 0;
    c->group_pow = 1;
    while (c->group_pow <= UINT64_MAX / radix) {
        c->group_pow *= radix;
        c->group_len++;
    }
    return FF1_OK;
}

void ff1_free(ff1_ctx *c)
{
    EVP_CIPHER_CTX_free(c->aes);
    BN_CTX_free(c->bn);
    c->aes = NULL;
    c->bn = NULL;
}

static inline int aes_block(ff1_ctx *c, uint8_t *out, const uint8_t *in)
{
    int outl;
    return EVP_EncryptUpdate(c->aes, out, &outl, in, BLOCK) == 1 && outl == BLOCK;
}

static int check_length(unsigned radix, size_t n)
{
    uint64_t p = 1;
    if (n < 2 || n > 0xffffffffUL)
        return 0;
    for (size_t i = 0; i < n; i++) {
        p *= radix;
        if (p >= MIN_DOMAIN)
            return 1;
    }
    return 0;
}

/* b = ceil(ceil(v*log2(radix))/8), exact (BouncyCastle calculateB_FF1). */
static int calc_b(ff1_ctx *c, unsigned radix, size_t v)
{
    int tz = __builtin_ctz(radix);
    size_t bits = (size_t)tz * v;
    unsigned odd = radix >> tz;
    if (odd != 1) {
        BN_CTX_start(c->bn);
        BIGNUM *r = BN_CTX_get(c->bn), *e = BN_CTX_get(c->bn), *p = BN_CTX_get(c->bn);
        if (!p || !BN_set_word(r, odd) || !BN_set_word(e, v) || !BN_exp(p, r, e, c->bn)) {
            BN_CTX_end(c->bn);
            return -1;
        }
        bits += BN_num_bits(p);
        BN_CTX_end(c->bn);
    }
    return (int)((bits + 7) / 8);
}

/* NUM_radix over uint64 digit groups. */
static int num(ff1_ctx *c, const uint16_t *x, size_t len, BIGNUM *res)
{
    BN_zero(res);
    for (size_t i = 0; i < len;) {
        size_t end = i + c->group_len;
        if (end > len)
            end = len;
        uint64_t acc = 0, p = 1;
        for (; i < end; i++) {
            acc = acc * c->radix + x[i];
            p *= c->radix;
        }
        if (!BN_mul_word(res, p) || !BN_add_word(res, acc))
            return 0;
    }
    return 1;
}

/* STR^m_radix; consumes (destroys) v. */
static int str(ff1_ctx *c, BIGNUM *v, uint16_t *out, size_t m)
{
    size_t i = m;
    while (i > 0) {
        uint64_t w = BN_div_word(v, c->group_pow);
        for (int k = 0; k < c->group_len && i > 0; k++) {
            out[--i] = (uint16_t)(w % c->radix);
            w /= c->radix;
        }
    }
    return 1;
}

static int crypt(ff1_ctx *c, const uint8_t *T, size_t t, const uint16_t *x,
                 uint16_t *out, size_t n, int enc)
{
    int ret = FF1_ERR_INTERNAL;
    if (!check_length(c->radix, n))
        return FF1_ERR_LENGTH;
    for (size_t i = 0; i < n; i++)
        if (x[i] >= c->radix)
            return FF1_ERR_DIGIT;

    size_t u = n / 2, v = n - u;
    int b = calc_b(c, c->radix, v);
    if (b < 0)
        return FF1_ERR_INTERNAL;
    int d = (b + 7) & ~3;

    uint8_t P[BLOCK] = {1, 2, 1, (uint8_t)(c->radix >> 16), (uint8_t)(c->radix >> 8),
                        (uint8_t)c->radix, 10, (uint8_t)u,
                        (uint8_t)(n >> 24), (uint8_t)(n >> 16), (uint8_t)(n >> 8), (uint8_t)n,
                        (uint8_t)(t >> 24), (uint8_t)(t >> 16), (uint8_t)(t >> 8), (uint8_t)t};
    uint8_t encP[BLOCK];
    if (!aes_block(c, encP, P))
        return FF1_ERR_INTERNAL;

    size_t zeros = (size_t)(-(long long)(t + b + 1)) & 15;
    size_t qlen = t + zeros + 1 + b;
    size_t round_idx = t + zeros, num_off = round_idx + 1;
    int n_blocks = (d + BLOCK - 1) / BLOCK;

    uint8_t qbuf[256], sbuf[256];
    uint8_t *Q = qlen <= sizeof qbuf ? qbuf : malloc(qlen);
    uint8_t *S = (size_t)n_blocks * BLOCK <= sizeof sbuf ? sbuf : malloc((size_t)n_blocks * BLOCK);
    if (!Q || !S)
        goto out_free;
    memcpy(Q, T, t);
    memset(Q + t, 0, qlen - t);

    BN_CTX_start(c->bn);
    BIGNUM *r = BN_CTX_get(c->bn), *e = BN_CTX_get(c->bn);
    BIGNUM *modU = BN_CTX_get(c->bn), *modV = BN_CTX_get(c->bn);
    BIGNUM *A = BN_CTX_get(c->bn), *B = BN_CTX_get(c->bn), *y = BN_CTX_get(c->bn);
    if (!y || !BN_set_word(r, c->radix) || !BN_set_word(e, u) ||
        !BN_exp(modU, r, e, c->bn))
        goto out;
    if (v != u) {
        if (!BN_mul(modV, modU, r, c->bn))
            goto out;
    } else if (!BN_copy(modV, modU)) {
        goto out;
    }
    if (!num(c, x, u, A) || !num(c, x + u, v, B))
        goto out;

    for (int k = 0; k < 10; k++) {
        int i = enc ? k : 9 - k;
        BIGNUM *src = enc ? B : A; /* half fed to the PRF */
        Q[round_idx] = (uint8_t)i;
        if (BN_bn2binpad(src, Q + num_off, b) != b)
            goto out;
        uint8_t R[BLOCK];
        memcpy(R, encP, BLOCK);
        for (size_t off = 0; off < qlen; off += BLOCK) {
            for (int j = 0; j < BLOCK; j++)
                R[j] ^= Q[off + j];
            if (!aes_block(c, R, R))
                goto out;
        }
        memcpy(S, R, BLOCK);
        uint32_t j0 = ((uint32_t)R[12] << 24) | ((uint32_t)R[13] << 16) |
                      ((uint32_t)R[14] << 8) | R[15];
        for (int j = 1; j < n_blocks; j++) {
            uint8_t *blk = S + j * BLOCK;
            uint32_t w = j0 ^ (uint32_t)j;
            memcpy(blk, R, 12);
            blk[12] = (uint8_t)(w >> 24);
            blk[13] = (uint8_t)(w >> 16);
            blk[14] = (uint8_t)(w >> 8);
            blk[15] = (uint8_t)w;
            if (!aes_block(c, blk, blk))
                goto out;
        }
        if (!BN_bin2bn(S, d, y))
            goto out;
        BIGNUM *mod = (i & 1) ? modV : modU;
        if (enc) {
            /* c = (A + y) mod radix^m; A = B; B = c */
            if (!BN_add(A, A, y) || !BN_nnmod(A, A, mod, c->bn))
                goto out;
            BIGNUM *tmp = A; A = B; B = tmp;
        } else {
            /* c = (B - y) mod radix^m; B = A; A = c */
            if (!BN_sub(B, B, y) || !BN_nnmod(B, B, mod, c->bn))
                goto out;
            BIGNUM *tmp = A; A = B; B = tmp;
        }
    }
    str(c, A, out, u);
    str(c, B, out + u, v);
    ret = FF1_OK;
out:
    BN_CTX_end(c->bn);
out_free:
    if (Q && Q != qbuf)
        free(Q);
    if (S && S != sbuf)
        free(S);
    return ret;
}

int ff1_encrypt(ff1_ctx *c, const uint8_t *tweak, size_t tweak_len,
                const uint16_t *in, uint16_t *out, size_t n)
{
    return crypt(c, tweak, tweak_len, in, out, n, 1);
}

int ff1_decrypt(ff1_ctx *c, const uint8_t *tweak, size_t tweak_len,
                const uint16_t *in, uint16_t *out, size_t n)
{
    return crypt(c, tweak, tweak_len, in, out, n, 0);
}
