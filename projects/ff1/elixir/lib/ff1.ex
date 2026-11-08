defmodule FF1 do
  @moduledoc """
  NIST SP 800-38G FF1 format-preserving encryption with AES (Erlang `:crypto`).

  Structure follows BouncyCastle's `SP80038G.encFF1/decFF1`. Optimizations
  (shared with the other ports in this repository):

    1. Per-(key, n, tweak length) values (b, d, `CIPH_K(P)`, radix^u, radix^v)
       are memoized in the calling process's dictionary, so repeated calls with
       the same length skip setup (including one AES call).
    2. Q blocks made only of tweak/zero bytes are CBC-MACed once per call.
    3. The Feistel halves stay integers across rounds (`NUM`/`STR` only at
       entry/exit). BEAM integers are arbitrary precision.
    4. When the varying part of Q is a single block and d <= 16 (radix^v < 2^96
       for short tweaks), each round is one integer XOR, one AES call and one
       shift; no per-round binary assembly or `:crypto.exor`.
    5. Hand-rolled tail-recursive NUM/STR (`Integer.digits/2` measured 540 ns).

  The per-call floor is the `:crypto.crypto_update/2` NIF (~450 ns per call on
  OTP 25, regardless of data size), and FF1 needs 10 sequential AES calls.

  Numeral strings are lists of integer digits, most significant first.
  """
  import Bitwise

  defstruct [:aes, :radix]

  @type t :: %__MODULE__{aes: reference(), radix: 2..65536}

  @min_domain 1_000_000

  @doc "Creates an FF1 cipher for a 16/24/32-byte AES key and radix in 2..65536."
  @spec new(binary(), pos_integer()) :: t()
  def new(key, radix) when is_binary(key) and is_integer(radix) do
    unless radix in 2..65536, do: raise(ArgumentError, "radix must be in [2, 65536]")

    cipher =
      case byte_size(key) do
        16 -> :aes_128_ecb
        24 -> :aes_192_ecb
        32 -> :aes_256_ecb
        _ -> raise ArgumentError, "key must be 16, 24 or 32 bytes"
      end

    %__MODULE__{aes: :crypto.crypto_init(cipher, key, true), radix: radix}
  end

  @doc "Encrypts a list of digits under `tweak` (binary)."
  @spec encrypt(t(), binary(), [non_neg_integer()]) :: [non_neg_integer()]
  def encrypt(%__MODULE__{} = c, tweak, digits), do: crypt(c, tweak, digits, true)

  @doc "Decrypts a list of digits under `tweak` (binary)."
  @spec decrypt(t(), binary(), [non_neg_integer()]) :: [non_neg_integer()]
  def decrypt(%__MODULE__{} = c, tweak, digits), do: crypt(c, tweak, digits, false)

  @doc false
  def length_ok?(radix, n), do: n >= 2 and Integer.pow(radix, n) >= @min_domain

  @doc false
  # b = ceil(ceil(v*log2(radix))/8), exact (BouncyCastle calculateB_FF1); used by tests.
  def calc_b(radix, v) do
    tz = trailing_zeros(radix, 0)
    odd = radix >>> tz
    bits = tz * v + if odd == 1, do: 0, else: bit_length(Integer.pow(odd, v))
    div(bits + 7, 8)
  end

  defp trailing_zeros(x, acc) when band(x, 1) == 1, do: acc
  defp trailing_zeros(x, acc), do: trailing_zeros(x >>> 1, acc + 1)

  defp bit_length(0), do: 0

  defp bit_length(x) do
    <<top, rest::binary>> = :binary.encode_unsigned(x)
    byte_size(rest) * 8 + bit_length_byte(top, 0)
  end

  defp bit_length_byte(0, acc), do: acc
  defp bit_length_byte(x, acc), do: bit_length_byte(x >>> 1, acc + 1)

  defp params(aes, radix, n, t) do
    key = {__MODULE__, aes, n, t}

    case Process.get(key) do
      nil ->
        unless length_ok?(radix, n),
          do: raise(ArgumentError, "input length out of range (radix^n must be >= 1000000)")

        if t > 0xFFFFFFFF, do: raise(ArgumentError, "tweak too long")
        u = div(n, 2)
        v = n - u
        mod_u = Integer.pow(radix, u)
        mod_v = if v == u, do: mod_u, else: mod_u * radix
        b = div(bit_length(mod_v - 1) + 7, 8)
        d = band(b + 7, bnot(3))
        p = <<1, 2, 1, radix::24, 10, band(u, 255), n::32, t::32>>
        <<enc_p::128>> = :crypto.crypto_update(aes, p)
        params = {u, b, d, enc_p, mod_u, mod_v}
        Process.put(key, params)
        params

      params ->
        params
    end
  end

  defp crypt(%__MODULE__{aes: aes, radix: radix}, tweak, x, enc?) when is_binary(tweak) do
    {n, xa, xb, u} = split_digits(x, radix)
    t = byte_size(tweak)
    {^u, b, d, enc_p, mod_u, mod_v} = params(aes, radix, n, t)

    zeros = Integer.mod(-(t + b + 1), 16)
    round_idx = t + zeros
    full = div(round_idx, 16) * 16
    # Constant part of Q (tweak, zero padding) before the round byte.
    qconst = <<tweak::binary, 0::size(zeros * 8)>>
    <<prefix::binary-size(full), rest::binary>> = qconst
    xs = cbc(aes, enc_p, prefix)
    a = undigits(xa, radix, 0)
    bn = undigits(xb, radix, 0)
    rlen = byte_size(rest)

    {a, bn} =
      if rlen + 1 + b == 16 and d <= 16 and not Process.get({__MODULE__, :force_general}, false) do
        # Single varying block: block = X xor rest||i||NUM(B), as one integer.
        <<rest_int::size(rlen * 8)>> = rest
        xc = bxor(xs, rest_int <<< ((16 - rlen) * 8))
        ishift = 8 * b
        yshift = 128 - 8 * d

        if enc?,
          do: enc_fast(aes, xc, ishift, yshift, mod_u, mod_v, a, bn, 0),
          else: dec_fast(aes, xc, ishift, yshift, mod_u, mod_v, a, bn, 9)
      else
        g = {aes, xs, rest, b * 8, d * 8, div(d + 15, 16)}

        if enc?,
          do: enc_gen(g, mod_u, mod_v, a, bn, 0),
          else: dec_gen(g, mod_u, mod_v, a, bn, 9)
      end

    str(a, radix, u, []) ++ str(bn, radix, n - u, [])
  end

  # Validates digits, counts them and splits at u = floor(n/2) in one pass each.
  defp split_digits(x, radix) do
    n = check_digits(x, radix, 0)
    u = div(n, 2)
    {xa, xb} = Enum.split(x, u)
    {n, xa, xb, u}
  end

  defp check_digits([], _radix, n), do: n

  defp check_digits([d | rest], radix, n) when is_integer(d) and d >= 0 and d < radix,
    do: check_digits(rest, radix, n + 1)

  defp check_digits(_, _radix, _n), do: raise(ArgumentError, "digit out of range for radix")

  defp aes_int(aes, x) do
    <<r::128>> = :crypto.crypto_update(aes, <<x::128>>)
    r
  end

  defp cbc(_aes, x, <<>>), do: x

  defp cbc(aes, x, <<blk::128, rest::binary>>), do: cbc(aes, aes_int(aes, bxor(x, blk)), rest)

  # ---- single-block rounds ----

  defp enc_fast(_aes, _xc, _is, _ys, _mu, _mv, a, b, 10), do: {a, b}

  defp enc_fast(aes, xc, is, ys, mu, mv, a, b, i) do
    y = aes_int(aes, bxor(xc, (i <<< is) + b)) >>> ys
    m = if band(i, 1) == 0, do: mu, else: mv
    enc_fast(aes, xc, is, ys, mu, mv, b, rem(a + y, m), i + 1)
  end

  defp dec_fast(_aes, _xc, _is, _ys, _mu, _mv, a, b, -1), do: {a, b}

  defp dec_fast(aes, xc, is, ys, mu, mv, a, b, i) do
    y = aes_int(aes, bxor(xc, (i <<< is) + a)) >>> ys
    m = if band(i, 1) == 0, do: mu, else: mv
    dec_fast(aes, xc, is, ys, mu, mv, Integer.mod(b - y, m), a, i - 1)
  end

  # ---- general rounds (multi-block Q tail and/or d > 16) ----

  defp prf({aes, xs, rest, bbits, dbits, n_blocks}, i, num) do
    r = cbc(aes, xs, <<rest::binary, i, num::size(bbits)>>)
    <<y::size(dbits), _::bits>> = expand(aes, r, n_blocks)
    y
  end

  defp enc_gen(_g, _mu, _mv, a, b, 10), do: {a, b}

  defp enc_gen(g, mu, mv, a, b, i) do
    m = if band(i, 1) == 0, do: mu, else: mv
    enc_gen(g, mu, mv, b, rem(a + prf(g, i, b), m), i + 1)
  end

  defp dec_gen(_g, _mu, _mv, a, b, -1), do: {a, b}

  defp dec_gen(g, mu, mv, a, b, i) do
    m = if band(i, 1) == 0, do: mu, else: mv
    dec_gen(g, mu, mv, Integer.mod(b - prf(g, i, a), m), a, i - 1)
  end

  # S = R || CIPH(R xor [1]^16) || CIPH(R xor [2]^16) || ...
  defp expand(_aes, r, 1), do: <<r::128>>

  defp expand(aes, r, n_blocks) do
    blocks = for j <- 1..(n_blocks - 1), into: <<>>, do: <<bxor(r, j)::128>>
    <<r::128, :crypto.crypto_update(aes, blocks)::binary>>
  end

  # NUM_radix: Horner over small-integer groups of g digits, then one bignum
  # multiply-add per group.
  defp undigits(xs, radix, acc) do
    {g, _gp} = group(radix)
    undigits_groups(xs, radix, g, acc)
  end

  defp undigits_groups([], _radix, _g, acc), do: acc

  defp undigits_groups(xs, radix, g, acc) do
    {chunk, pw, rest} = take_group(xs, radix, g, 0, 1)
    undigits_groups(rest, radix, g, acc * pw + chunk)
  end

  defp take_group(rest, _radix, 0, acc, pw), do: {acc, pw, rest}
  defp take_group([], _radix, _k, acc, pw), do: {acc, pw, []}
  defp take_group([d | rest], radix, k, acc, pw), do: take_group(rest, radix, k - 1, acc * radix + d, pw * radix)

  # STR^m_radix(x): peel off radix^g-sized groups (small integers, g chosen so
  # radix^g < 2^59 stays a BEAM immediate), then digits within each group.
  defp str(x, radix, m, acc) when x < 1 <<< 59, do: str_small(x, radix, m, acc)

  defp str(x, radix, m, acc) do
    {g, gp} = group(radix)

    if m <= g do
      str_small(x, radix, m, acc)
    else
      str(div(x, gp), radix, m - g, str_small(rem(x, gp), radix, g, acc))
    end
  end

  defp str_small(_x, _radix, 0, acc), do: acc
  defp str_small(x, radix, m, acc), do: str_small(div(x, radix), radix, m - 1, [rem(x, radix) | acc])

  defp group(radix) do
    case Process.get({__MODULE__, :group, radix}) do
      nil ->
        g = group_len(radix, 1, 0)
        r = {g, Integer.pow(radix, g)}
        Process.put({__MODULE__, :group, radix}, r)
        r

      r ->
        r
    end
  end

  defp group_len(radix, p, g) when p * radix < 1 <<< 59, do: group_len(radix, p * radix, g + 1)
  defp group_len(_radix, _p, g), do: g
end
