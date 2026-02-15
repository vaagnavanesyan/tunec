#!/bin/sh

#
# Gradle start up script for POSIX
#

app_path=$0
while
  APP_HOME=${app_path%"${app_path##*/}"}
  [ -h "$app_path" ]
do
  ls=$( ls -ld "$app_path" )
  link=${ls#*' -> '}
  case $link in
   /*) app_path=$link ;;
   *) app_path=$APP_HOME$link ;;
  esac
done
APP_BASE_NAME=${0##*/}
APP_HOME=$( cd "${APP_HOME:-./}" > /dev/null && pwd -P ) || exit

die () { echo "$*" >&2; exit 1; }

CLASSPATH=$APP_HOME/gradle/wrapper/gradle-wrapper.jar

if [ -n "$JAVA_HOME" ]; then
  JAVACMD=${JAVA_HOME}/bin/java
  [ -x "$JAVACMD" ] || die "JAVA_HOME is set to an invalid directory: $JAVA_HOME"
else
  JAVACMD=java
  command -v java >/dev/null 2>&1 || die "JAVA_HOME is not set and no 'java' command could be found in your PATH."
fi

exec "$JAVACMD" -Dfile.encoding=UTF-8 -Xmx64m -Xms64m -Dorg.gradle.appname="$APP_BASE_NAME" -classpath "$CLASSPATH" org.gradle.wrapper.GradleWrapperMain "$@"
