require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
load 'nitrogen/generated/ios/MoveMatchPoseTracker+autolinking.rb'

Pod::Spec.new do |s|
  s.name = 'MoveMatchPoseTracker'
  s.version = package['version']
  s.summary = 'On-device MediaPipe Pose Landmarker adapter for MOVE / MATCH.'
  s.homepage = 'https://example.invalid/move-match'
  s.license = { :type => 'Proprietary' }
  s.author = 'MOVE / MATCH'
  s.source = { :path => '.' }
  s.platform = :ios, '17.0'
  s.swift_version = '5.9'
  s.module_name = 'MoveMatchPoseTracker'
  s.source_files = 'ios/**/*.{h,m,mm,swift}', 'nitrogen/generated/ios/**/*.{h,mm,cpp,swift}'
  s.resource_bundles = { 'MoveMatchPoseTrackerResources' => ['assets/*.task'] }
  add_nitrogen_files(s)
  s.dependency 'VisionCamera'
  s.dependency 'MediaPipeTasksVision', '1.0.0'
end
