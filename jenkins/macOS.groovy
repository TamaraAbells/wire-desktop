@NonCPS
def parseJson(def text) {
  new groovy.json.JsonSlurperClassic().parseText(text)
}

node('master') {

  def production = params.PRODUCTION
  def custom = params.CUSTOM

  def jenkinsbot_secret = ''
  withCredentials([string(credentialsId: "${params.JENKINSBOT_SECRET}", variable: 'JENKINSBOT_SECRET')]) {
    jenkinsbot_secret = env.JENKINSBOT_SECRET
  }

  stage('Checkout & Clean') {
    git branch: "${GIT_BRANCH}", url: 'https://github.com/wireapp/wire-desktop.git'
    sh returnStatus: true, script: 'rm -rf wrap/ electron/node_modules/ node_modules/ *.sig'
  }

  def text = readFile('info.json')
  def buildInfo = parseJson(text)
  def version = buildInfo.version + '.' + env.BUILD_NUMBER
  currentBuild.displayName = version

  stage('Build') {
    try {
      withCredentials([string(credentialsId: 'MACOS_KEYCHAIN_PASSWORD', variable: 'MACOS_KEYCHAIN_PASSWORD')]) {
        sh "security unlock-keychain -p ${MACOS_KEYCHAIN_PASSWORD} /Users/jenkins/Library/Keychains/login.keychain"
      }
      sh 'pip install -r jenkins/requirements.txt'
      def NODE = tool name: 'node-v10.15.3', type: 'nodejs'
      withEnv(["PATH+NODE=${NODE}/bin"]) {
        sh 'node -v'
        sh 'npm -v'
        sh 'npm install -g yarn'
        sh 'yarn'
        withCredentials([string(credentialsId: 'RAYGUN_API_KEY', variable: 'RAYGUN_API_KEY')]) {
          if (production) {
            sh 'yarn build:macos'
          } else if (custom) {
            sh 'yarn build:macos:custom'
          } else {
            sh 'yarn build:macos:internal'
          }
        }
      }
    } catch(e) {
      currentBuild.result = 'FAILED'
      wireSend secret: "${jenkinsbot_secret}", message: "🍏 **${JOB_NAME} ${version} build failed** see: ${JOB_URL}"
      throw e
    }
  }

  if (production) {
    stage('Create SHA256 checksums') {
      withCredentials([file(credentialsId: 'D599C1AA126762B1.asc', variable: 'PGP_PRIVATE_KEY_FILE'), string(credentialsId: 'PGP_PASSPHRASE', variable: 'PGP_PASSPHRASE')]) {
        sh "bin/macos-checksums.sh ${version}"
      }
    }
  }

  stage('Archive build artifacts') {
    if (production) {
      archiveArtifacts 'Wire.pkg'
    } else if (custom) {
      archiveArtifacts '*.pkg'
    } else {
      // Internal
      sh "ditto -c -k --sequesterRsrc --keepParent \"${WORKSPACE}/wrap/build/WireInternal-mas-x64/WireInternal.app/\" \"${WORKSPACE}/wrap/WireInternal.zip\""
      archiveArtifacts "wrap/WireInternal.zip,${version}.tar.gz.sig"
    }
  }

  wireSend secret: "${jenkinsbot_secret}", message: "🍏 **New build of ${JOB_NAME} ${version} available for download on** ${JOB_URL}"
}
