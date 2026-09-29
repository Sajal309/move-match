package com.movematch.pose

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import com.margelo.nitro.movematch.pose.MoveMatchPoseTrackerOnLoad

internal object PoseTrackerAppContext {
  @Volatile var application: Context? = null
}

class MoveMatchPoseTrackerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MoveMatchPoseTracker")
    OnCreate {
      MoveMatchPoseTrackerOnLoad.initializeNative()
      PoseTrackerAppContext.application = appContext.reactContext?.applicationContext
    }
    OnDestroy {
      PoseTrackerAppContext.application = null
    }
  }
}
