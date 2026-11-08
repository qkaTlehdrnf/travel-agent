#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
SDK=/usr/lib/android-sdk/platforms/android-23/android.jar
OUT=build; rm -rf $OUT; mkdir -p $OUT/gen $OUT/classes $OUT/assets/www
cp -r web/. $OUT/assets/www/
aapt package -f -m -J $OUT/gen -M android/AndroidManifest.xml -S android/res -I $SDK -F $OUT/res.apk -A $OUT/assets
javac -nowarn -source 8 -target 8 -encoding UTF-8 -bootclasspath $SDK -classpath $SDK -d $OUT/classes $(find android/src $OUT/gen -name '*.java') 2>&1 | grep -v "bootstrap\|warning: \[options\]" || true
ls $OUT/classes/com/wonjoong/travelagent/MainActivity.class >/dev/null
dalvik-exchange --dex --output=$OUT/classes.dex $OUT/classes
cp $OUT/res.apk $OUT/unsigned.apk
(cd $OUT && zip -q -j unsigned.apk classes.dex)
zipalign -f 4 $OUT/unsigned.apk $OUT/aligned.apk
KS=${KEYSTORE:-keystore/release.jks}
apksigner sign --ks "$KS" --ks-pass pass:${KS_PASS:-travelagent} --out $OUT/travel-agent.apk $OUT/aligned.apk
apksigner verify $OUT/travel-agent.apk && ls -la $OUT/travel-agent.apk
