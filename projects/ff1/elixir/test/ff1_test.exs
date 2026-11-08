defmodule FF1Test do
  use ExUnit.Case, async: true

  @alpha ~c"0123456789abcdefghijklmnopqrstuvwxyz"
  @k128 "2B7E151628AED2A6ABF7158809CF4F3C"
  @k192 @k128 <> "EF4359D8D580AA4F"
  @k256 @k192 <> "7F036D6F04FC6A94"
  @t1 "39383736353433323130"
  @t2 "3737373770717273373737"

  defp parse(s), do: s |> String.to_charlist() |> Enum.map(fn ch -> Enum.find_index(@alpha, &(&1 == ch)) end)
  defp fmt(x), do: x |> Enum.map(&Enum.at(@alpha, &1)) |> List.to_string()
  defp hex(s), do: Base.decode16!(s, case: :mixed)

  @vectors [
    {@k128, "", 10, "0123456789", "2433477484"},
    {@k128, @t1, 10, "0123456789", "6124200773"},
    {@k128, @t2, 36, "0123456789abcdefghi", "a9tv40mll9kdu509eum"},
    {@k192, "", 10, "0123456789", "2830668132"},
    {@k192, @t1, 10, "0123456789", "2496655549"},
    {@k192, @t2, 36, "0123456789abcdefghi", "xbj3kv35jrawxv32ysr"},
    {@k256, "", 10, "0123456789", "6657667009"},
    {@k256, @t1, 10, "0123456789", "1001623463"},
    {@k256, @t2, 36, "0123456789abcdefghi", "xs8a0azh2avyalyzuwd"}
  ]

  test "NIST SP 800-38G FF1 samples 1-9" do
    for {{k, tw, radix, pt, ct}, i} <- Enum.with_index(@vectors, 1) do
      c = FF1.new(hex(k), radix)
      assert fmt(FF1.encrypt(c, hex(tw), parse(pt))) == ct, "sample #{i} encrypt"
      assert fmt(FF1.decrypt(c, hex(tw), parse(ct))) == pt, "sample #{i} decrypt"
    end
  end

  test "NIST samples via the general (multi-block) round path" do
    Process.put({FF1, :force_general}, true)

    try do
      for {k, tw, radix, pt, ct} <- @vectors do
        c = FF1.new(hex(k), radix)
        assert fmt(FF1.encrypt(c, hex(tw), parse(pt))) == ct
        assert fmt(FF1.decrypt(c, hex(tw), parse(ct))) == pt
      end
    after
      Process.delete({FF1, :force_general})
    end
  end

  test "pseudorandom round trips, fast path agrees with general path" do
    :rand.seed(:exsss, {1, 2, 3})
    radices = [2, 3, 10, 16, 26, 36, 62, 255, 256, 1000, 65535, 65536]

    for it <- 0..1999 do
      radix = Enum.at(radices, rem(it, length(radices)))
      key = :crypto.strong_rand_bytes(Enum.at([16, 24, 32], rem(it, 3)))
      tw = :crypto.strong_rand_bytes(:rand.uniform(40) - 1)
      n = 1 + :rand.uniform(if rem(it, 2) == 1, do: 40, else: 150)

      if FF1.length_ok?(radix, n) do
        x = for _ <- 1..n, do: :rand.uniform(radix) - 1
        c = FF1.new(key, radix)
        ct = FF1.encrypt(c, tw, x)
        assert FF1.decrypt(c, tw, ct) == x
        Process.put({FF1, :force_general}, true)
        assert FF1.encrypt(FF1.new(key, radix), tw, x) == ct
        Process.delete({FF1, :force_general})
      end
    end
  end

  test "calc_b is exact" do
    for r <- [2, 3, 7, 8, 10, 16, 36, 64, 255, 256, 1000, 65536], v <- 1..79 do
      want = div(bitlen(Integer.pow(r, v) - 1) + 7, 8)
      assert FF1.calc_b(r, v) == want, "r=#{r} v=#{v}"
    end
  end

  defp bitlen(0), do: 0
  defp bitlen(x), do: 1 + bitlen(Bitwise.bsr(x, 1))

  test "validation" do
    assert_raise ArgumentError, fn -> FF1.new(<<0::128>>, 1) end
    assert_raise ArgumentError, fn -> FF1.new(<<0::120>>, 10) end
    c = FF1.new(<<0::128>>, 10)
    assert_raise ArgumentError, fn -> FF1.encrypt(c, "", parse("12345")) end
    assert_raise ArgumentError, fn -> FF1.encrypt(c, "", [1, 2, 3, 4, 5, 6, 10]) end
  end
end
