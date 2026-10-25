-keep class expo.modules.arxdrxd.display.DisplayServer { public static void main(java.lang.String[]); }

# Conscrypt's pre-Android-5 socket adapters are unreachable on Arxd (minSdk 26).
-dontwarn com.android.org.conscrypt.SSLParametersImpl
-dontwarn org.apache.harmony.xnet.provider.jsse.SSLParametersImpl

# libadb selects this private provider reflectively; do not install it globally.
-keep class org.conscrypt.OpenSSLProvider { public <init>(); }
-keep class org.conscrypt.Conscrypt {
    public static byte[] exportKeyingMaterial(javax.net.ssl.SSLSocket, java.lang.String, byte[], int);
}
